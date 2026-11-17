// HTTP API. `ctx` is { env, db } and is built by the entrypoint (node.js or worker.js).
import { iso, now } from './util.js'
import { newId, newWebhookSecret, sha256, safeEqual } from './crypto.js'
import { nextRun } from './schedule.js'
import * as store from './store.js'
import { tick, newRun } from './runner.js'
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

async function requireApiKey(ctx, req) {
  if (!ctx.env.API_KEY) fail(500, 'internal_error', 'API_KEY is not configured on the server')
  const header = req.headers.get('authorization') ?? ''
  const token = header.replace(/^Bearer\s+/i, '')
  if (!(await safeEqual(token, ctx.env.API_KEY))) fail(401, 'invalid_api_key', 'Invalid API key')
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

  const webhook = body.webhook == null ? null : validWebhook(body.webhook)
  const createdAt = now()
  const monitor = {
    id: newId('mon_'),
    name: validString(body.name, 'name', 1, 256),
    goal: body.goal === undefined ? '' : validString(body.goal, 'goal', 0, 2000),
    targets: validTargets(body.targets),
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
    const targets = validTargets(body.targets)
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
      const webhook = validWebhook(body.webhook)
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

async function route(ctx, req, background) {
  const url = new URL(req.url)
  const path = url.pathname.replace(/\/+$/, '')
  const method = req.method

  if (path === '/health') return json(200, { ok: true })

  await requireApiKey(ctx, req)

  // for hosts with no long-running process: point any external cron at this
  if (path === '/tick' && method === 'POST') {
    await tick(ctx)
    return json(200, { ok: true })
  }

  if (path === '/v1/monitors') {
    if (method === 'POST') return createMonitor(ctx, req)
    if (method === 'GET') {
      const limit = validLimit(url.searchParams.get('limit'))
      const page = await store.listMonitors(ctx.db, url.searchParams.get('after'), limit)
      return json(200, {
        object: 'list',
        data: page.data.map((m) => monitorView(m)),
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

  if (action === '') {
    if (method === 'GET') return json(200, monitorView(monitor))
    if (method === 'PATCH') return updateMonitor(ctx, req, monitor)
    if (method === 'DELETE') {
      await store.deleteMonitor(ctx.db, id)
      return json(200, { id, object: 'monitor', deleted: true })
    }
  }

  if (method === 'POST') {
    if (action === '/pause') return pauseMonitor(ctx, monitor)
    if (action === '/resume') return resumeMonitor(ctx, monitor)
    if (action === '/run') return runNow(ctx, monitor, background)
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
  try {
    return await route(ctx, req, background)
  } catch (e) {
    return errorResponse(e)
  }
}
