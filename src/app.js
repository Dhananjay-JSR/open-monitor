// HTTP API. `ctx` is { env, db } and is built by the entrypoint (node.js or worker.js).
import { iso, now } from './util.js'
import { newId, newWebhookSecret, sha256, safeEqual } from './crypto.js'
import { nextRun } from './schedule.js'
import * as store from './store.js'
import { tick, newRun } from './runner.js'
import { buildEvent, deliver } from './webhooks.js'
import { dashboardEnabled, sessionUser, login, logout } from './auth.js'
import { judgeConfigured } from './judge.js'
import {
  ApiError,
  fail,
  checkFields,
  validString,
  validTargets,
  validSchedule,
  validWebhook,
  validMetadata,
  validLimit,
} from './validate.js'

const DAY_MS = 24 * 60 * 60 * 1000
const WRITABLE_FIELDS = ['name', 'goal', 'targets', 'schedule', 'webhook', 'metadata']

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function errorResponse(e) {
  if (e instanceof ApiError) {
    return json(e.status, { error: { message: e.message, type: e.type, code: e.status, ...e.extra } })
  }
  console.error(e)
  return json(500, { error: { message: 'Internal error', type: 'internal_error', code: 500 } })
}

// what the API returns for a monitor. `secret` is only passed right after it was generated.
function monitorView(m, secret) {
  let webhook = null
  if (m.webhook) {
    webhook = { ...m.webhook }
    if (secret) webhook.secret = secret
  }
  return store.dropNulls({
    id: m.id,
    object: 'monitor',
    name: m.name,
    goal: m.goal,
    targets: m.targets,
    schedule: m.schedule,
    webhook,
    metadata: m.metadata,
    status: m.status,
    pause_reason: m.pause_reason,
    current_run_id: m.current_run_id,
    next_run_at: m.next_run_at,
    last_run: m.last_run,
    created_at: m.created_at,
    updated_at: m.updated_at,
  })
}

// Add-ons can wrap the server and plug into three places through ctx.hooks (all optional):
//
//   identify(ctx, req)             who is this, for requests the core itself could not
//                                  authenticate. Returns an identity or null.
//   routes(ctx, req)               extra endpoints. Returns a Response, or null to pass.
//   onEvent(ctx, monitor, type, run)  called for every monitor event, next to the webhook.
//
// An identity is { role, allow(method, action, monitor), view?(monitor), afterRun?(monitor) }.
// `allow` says whether this caller may do the request, `view` can trim what they see of a
// monitor, and `afterRun` is told when a manual run they asked for was actually queued.
const OWNER = { role: 'owner' }

// API clients send the key as a bearer token. The dashboard has no key, it rides on the
// login session cookie instead.
async function authenticate(ctx, req) {
  if (!ctx.env.API_KEY) fail(500, 'internal_error', 'API_KEY is not configured on the server')

  const header = req.headers.get('authorization')
  if (header) {
    const token = header.replace(/^Bearer\s+/i, '')
    if (await safeEqual(token, ctx.env.API_KEY)) return OWNER
  } else if (await sessionUser(ctx, req)) {
    checkSameSite(req)
    return OWNER
  }

  const identity = await ctx.hooks?.identify?.(ctx, req)
  if (!identity) fail(401, 'invalid_api_key', 'Invalid API key')
  return identity
}

// The session cookie is SameSite=Strict already. This is a second check: browsers label
// every request with where it came from, and anything not from our own page is refused.
export function checkSameSite(req) {
  const site = req.headers.get('sec-fetch-site')
  if (site && site !== 'same-origin') fail(403, 'forbidden', 'Cross-site requests are not allowed')
}

async function requireAllowed(identity, method, action, monitor) {
  if (identity.role === 'owner') return
  if (!(await identity.allow(method, action, monitor))) {
    fail(403, 'forbidden', 'This account is not allowed to do that')
  }
}

function present(identity, monitor, secret) {
  const view = monitorView(monitor, secret)
  return identity.view ? identity.view(view) : view
}

async function readJson(req) {
  const text = await req.text()
  try {
    return { body: JSON.parse(text), text }
  } catch {
    fail(400, 'invalid_request', 'Body must be valid JSON')
  }
}

async function createMonitor(ctx, req) {
  const { body, text } = await readJson(req)
  checkFields(body, WRITABLE_FIELDS, '')

  const idemKey = req.headers.get('idempotency-key')
  let idemHash = null
  if (idemKey) {
    if (idemKey.length > 200) fail(400, 'invalid_request', 'Idempotency-Key is too long', { param: 'Idempotency-Key' })
    idemHash = await sha256(text)
    const existing = await store.getMonitorByIdemKey(ctx.db, idemKey)
    if (existing) {
      if (existing.idem_hash !== idemHash) {
        fail(400, 'invalid_request', 'Idempotency-Key was already used with a different body', { param: 'Idempotency-Key' })
      }
      // same key + same body: return what we created the first time, without the secret
      return json(200, monitorView(existing))
    }
  }

  const webhook = body.webhook == null ? null : validWebhook(body.webhook, ctx.env)
  const createdAt = now()
  const monitor = {
    id: newId('mon_'),
    name: validString(body.name, 'name', 1, 256),
    goal: body.goal === undefined ? '' : validString(body.goal, 'goal', 0, 2000),
    targets: validTargets(body.targets, ctx.env),
    schedule: validSchedule(body.schedule),
    webhook: webhook && { url: webhook.url, events: webhook.events },
    metadata: body.metadata === undefined ? {} : validMetadata(body.metadata),
    status: 'active',
    secret: null,
    idem_hash: idemHash,
    created_at: createdAt,
    updated_at: createdAt,
  }
  monitor.next_run_at = iso(nextRun(monitor.schedule, Date.now()))

  let generatedSecret = null
  if (webhook) {
    if (!webhook.secret) generatedSecret = newWebhookSecret()
    monitor.secret = webhook.secret ?? generatedSecret
  }

  await store.insertMonitor(ctx.db, monitor, idemKey)
  const saved = await store.getMonitor(ctx.db, monitor.id)
  return json(200, monitorView(saved, generatedSecret))
}

// PATCH: a present key replaces the whole field, null clears goal/metadata/webhook
async function updateMonitor(ctx, req, monitor) {
  const { body } = await readJson(req)
  checkFields(body, WRITABLE_FIELDS, '')

  let generatedSecret = null
  let removedPages = []

  if ('name' in body) monitor.name = validString(body.name, 'name', 1, 256)
  if ('goal' in body) monitor.goal = body.goal === null ? '' : validString(body.goal, 'goal', 0, 2000)
  if ('metadata' in body) monitor.metadata = body.metadata === null ? {} : validMetadata(body.metadata)

  if ('schedule' in body) {
    monitor.schedule = validSchedule(body.schedule)
    if (monitor.status === 'active') {
      monitor.next_run_at = iso(nextRun(monitor.schedule, Date.now()))
    }
  }

  if ('targets' in body) {
    const targets = validTargets(body.targets, ctx.env)
    // pages that are no longer watched lose their baseline, the rest keep theirs
    const stillThere = targets.map((t) => t.url)
    removedPages = monitor.targets.filter((t) => t.url && !stillThere.includes(t.url)).map((t) => t.url)
    monitor.targets = targets
  }

  if ('webhook' in body) {
    if (body.webhook === null) {
      monitor.webhook = null
      monitor.secret = null
      monitor.old_secret = null
      monitor.old_secret_until = null
    } else {
      const webhook = validWebhook(body.webhook, ctx.env)
      monitor.webhook = { url: webhook.url, events: webhook.events }
      if (webhook.secret && monitor.secret && webhook.secret !== monitor.secret) {
        // rotation: the old secret keeps signing for 24h
        monitor.old_secret = monitor.secret
        monitor.old_secret_until = iso(Date.now() + DAY_MS)
      }
      if (webhook.secret) {
        monitor.secret = webhook.secret
      } else if (!monitor.secret) {
        generatedSecret = newWebhookSecret()
        monitor.secret = generatedSecret
      }
    }
  }

  monitor.updated_at = now()
  const saved = await store.updateMonitor(ctx.db, monitor, removedPages)
  if (!saved) fail(409, 'conflict', 'The monitor was modified concurrently; retry')
  return json(200, monitorView(await store.getMonitor(ctx.db, monitor.id), generatedSecret))
}

async function pauseMonitor(ctx, monitor) {
  if (monitor.status !== 'active') fail(409, 'invalid_state', 'Monitor is already paused')
  const { db } = ctx
  await db.run(
    `UPDATE monitors SET status = 'paused', pause_reason = 'user', next_run_at = NULL WHERE id = ?`,
    [monitor.id],
  )
  // a run that hasn't started yet is cancelled. One that is already running is left to finish.
  await db.run(
    `UPDATE runs SET status = 'skipped', skip_reason = 'user', error_message = ?, finished_at = ?
     WHERE monitor_id = ? AND status = 'queued'`,
    ['The monitor was paused before the run started', now(), monitor.id],
  )
  await db.run(
    `UPDATE monitors SET current_run_id = NULL
     WHERE id = ? AND current_run_id IN (SELECT id FROM runs WHERE monitor_id = ? AND status = 'skipped')`,
    [monitor.id, monitor.id],
  )
  return json(200, monitorView(await store.getMonitor(db, monitor.id)))
}

async function resumeMonitor(ctx, monitor) {
  if (monitor.status === 'active') fail(409, 'invalid_state', 'Monitor is not paused')
  const next = iso(nextRun(monitor.schedule, Date.now()))
  await ctx.db.run(
    `UPDATE monitors SET status = 'active', pause_reason = NULL, fail_streak = 0, next_run_at = ? WHERE id = ?`,
    [next, monitor.id],
  )
  return json(200, monitorView(await store.getMonitor(ctx.db, monitor.id)))
}

async function runNow(ctx, monitor, background) {
  if (monitor.status !== 'active') fail(409, 'invalid_state', 'Monitor is paused; resume it first')
  const { db } = ctx

  const run = newRun(monitor.id, 'manual', 'queued')
  const claimed = await db.run(
    'UPDATE monitors SET current_run_id = ? WHERE id = ? AND current_run_id IS NULL',
    [run.id, monitor.id],
  )
  if (claimed.changes === 0) {
    const current = await store.getMonitor(db, monitor.id)
    fail(409, 'run_in_progress', 'A run is already queued or running', {
      current_run_id: current.current_run_id,
    })
  }

  await store.insertRun(db, run)
  const queued = await store.getRun(db, monitor.id, run.id)
  // respond with the queued run right away, the tick does the actual work
  background(tick(ctx))
  return json(202, queued)
}

// sends a signed monitor.webhook.test event right away and reports what the receiver said
async function testWebhook(ctx, monitor) {
  if (!monitor.webhook) fail(409, 'invalid_state', 'Monitor has no webhook')
  const event = buildEvent(monitor, 'monitor.webhook.test')
  const result = await deliver(ctx, monitor, event.id, JSON.stringify(event))
  return json(200, { object: 'monitor.webhook_test', event_id: event.id, ...result })
}

async function route(ctx, req, background) {
  const url = new URL(req.url)
  const path = url.pathname.replace(/\/+$/, '')
  const method = req.method

  if (path === '/health') return json(200, { ok: true })

  if (path === '' && method === 'GET') {
    if (!dashboardEnabled(ctx.env) || !ctx.dashboard) fail(404, 'not_found', 'Not found')
    // an add-on can append its own markup and script to the page
    // (a function as the replacement, so "$" sequences in the add-on's script are left alone)
    const page = ctx.dashboardExtra ? ctx.dashboard.replace('</body>', () => ctx.dashboardExtra + '</body>') : ctx.dashboard
    return new Response(page, {
      headers: {
        'content-type': 'text/html; charset=utf-8',
        // everything is inline in the one html file, nothing may load from elsewhere
        'content-security-policy':
          "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:; font-src data:; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
        'x-content-type-options': 'nosniff',
        'referrer-policy': 'no-referrer',
      },
    })
  }
  if (path === '/auth/login' && method === 'POST') return login(ctx, req)
  if (path === '/auth/logout' && method === 'POST') return logout(ctx, req)
  if (path === '/auth/session' && method === 'GET') {
    const username = await sessionUser(ctx, req)
    if (!username) fail(401, 'not_logged_in', 'Not logged in')
    // judge_configured lets the dashboard warn that runs will fail without an LLM
    return json(200, { username, judge_configured: judgeConfigured(ctx.env) })
  }

  // add-on endpoints get first refusal
  const extra = await ctx.hooks?.routes?.(ctx, req)
  if (extra) return extra

  const identity = await authenticate(ctx, req)

  // for hosts with no long-running process: point any external cron at this
  if (path === '/tick' && method === 'POST') {
    await requireAllowed(identity, 'POST', '/tick')
    await tick(ctx)
    return json(200, { ok: true })
  }

  if (path === '/v1/monitors') {
    if (method === 'POST') {
      await requireAllowed(identity, 'POST', '/monitors')
      return createMonitor(ctx, req)
    }
    if (method === 'GET') {
      await requireAllowed(identity, 'GET', '/monitors')
      const limit = validLimit(url.searchParams.get('limit'))
      const page = await store.listMonitors(ctx.db, url.searchParams.get('after'), limit)
      return json(200, {
        object: 'list',
        data: page.data.map((m) => present(identity, m)),
        has_more: page.has_more,
      })
    }
  }

  const match = /^\/v1\/monitors\/([^/]+)(\/.+)?$/.exec(path)
  if (!match) fail(404, 'not_found', 'Not found')
  const id = match[1]
  const action = match[2] ?? ''

  const monitor = await store.getMonitor(ctx.db, id)
  if (!monitor) fail(404, 'not_found', 'Monitor not found')
  await requireAllowed(identity, method, action, monitor)

  if (action === '') {
    if (method === 'GET') return json(200, present(identity, monitor))
    if (method === 'PATCH') return updateMonitor(ctx, req, monitor)
    if (method === 'DELETE') {
      await store.deleteMonitor(ctx.db, id)
      return json(200, { id, object: 'monitor', deleted: true })
    }
  }

  if (method === 'POST') {
    if (action === '/pause') return pauseMonitor(ctx, monitor)
    if (action === '/resume') return resumeMonitor(ctx, monitor)
    if (action === '/run') {
      const res = await runNow(ctx, monitor, background)
      await identity.afterRun?.(monitor)
      return res
    }
    if (action === '/webhook/test') return testWebhook(ctx, monitor)
  }

  // extension to the Perplexity API: the webhook delivery log for this monitor
  if (method === 'GET' && action === '/deliveries') {
    const limit = validLimit(url.searchParams.get('limit'))
    const page = await store.listDeliveryAttempts(ctx.db, id, url.searchParams.get('after'), limit)
    return json(200, { object: 'list', data: page.data, has_more: page.has_more })
  }

  if (method === 'GET' && action === '/runs') {
    const limit = validLimit(url.searchParams.get('limit'))
    const page = await store.listRuns(ctx.db, id, url.searchParams.get('after'), limit)
    return json(200, { object: 'list', data: page.data, has_more: page.has_more })
  }

  if (method === 'GET' && action.startsWith('/runs/')) {
    const run = await store.getRun(ctx.db, id, action.slice('/runs/'.length))
    if (!run) fail(404, 'not_found', 'Run not found')
    return json(200, run)
  }

  fail(404, 'not_found', 'Not found')
}

// `background` takes a promise that should keep running after the response is sent
// (ctx.waitUntil on Workers, fire-and-forget on Node).
export async function handle(ctx, req, background) {
  const span = ctx.telemetry.startSpan('http.request', { 'http.method': req.method })
  let response
  try {
    response = await route(ctx, req, background)
  } catch (e) {
    response = errorResponse(e)
  }
  // the path is left out on purpose, ids are fine but query strings and tokens are not
  span.end({ 'http.status_code': response.status }, response.status >= 500 ? 'server error' : undefined)
  if (ctx.telemetry.enabled) background(ctx.telemetry.flush())
  return response
}
