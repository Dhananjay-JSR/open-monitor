// Dashboard login. Separate from the API key: a username/password form that creates a
// server-side session, referenced by a signed, HttpOnly cookie.
import { iso, now } from './util.js'
import { randomToken, sha256, hmacHex, safeEqual } from './crypto.js'
import { fail } from './validate.js'

const COOKIE = 'om_session'
const SESSION_HOURS = 12
const MAX_FAILURES = 5
const LOCK_MINUTES = 15

// the dashboard stays off until all three are set
export function dashboardEnabled(env) {
  return Boolean(env.DASHBOARD_USER && env.DASHBOARD_PASSWORD && env.SESSION_SECRET)
}

function clientIp(env, req) {
  // only believe X-Forwarded-For when the operator says there is a proxy in front
  if (env.TRUST_PROXY) {
    const forwarded = req.headers.get('x-forwarded-for')
    if (forwarded) return forwarded.split(',')[0].trim()
  }
  return req.headers.get('cf-connecting-ip') ?? req.ip ?? 'unknown'
}

function isHttps(req) {
  return new URL(req.url).protocol === 'https:' || req.headers.get('x-forwarded-proto') === 'https'
}

function sessionCookie(req, value, maxAgeSeconds) {
  let cookie = `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSeconds}`
  if (isHttps(req)) cookie += '; Secure'
  return cookie
}

function readCookie(req) {
  const header = req.headers.get('cookie') ?? ''
  for (const part of header.split(';')) {
    const [name, ...rest] = part.trim().split('=')
    if (name === COOKIE) return rest.join('=')
  }
  return null
}

// Returns the logged-in username, or null.
export async function sessionUser(ctx, req) {
  if (!dashboardEnabled(ctx.env)) return null
  const cookie = readCookie(req)
  if (!cookie) return null

  const [token, signature] = cookie.split('.')
  if (!token || !signature) return null
  // check the signature first, so made-up cookies never reach the database
  const expected = await hmacHex(ctx.env.SESSION_SECRET, token)
  if (!(await safeEqual(signature, expected))) return null

  const rows = await ctx.db.all('SELECT username, expires_at FROM sessions WHERE token_hash = ?', [await sha256(token)])
  const session = rows[0]
  if (!session || session.expires_at <= now()) return null
  return session.username
}

// Failed logins are counted per (username, ip). Unknown usernames share one bucket per ip
// so that guessing random names can't fill the table.
async function attemptKey(ctx, req, username) {
  const known = await safeEqual(username, ctx.env.DASHBOARD_USER)
  return { username: known ? ctx.env.DASHBOARD_USER : '*', ip: clientIp(ctx.env, req), known }
}

async function recordFailure(ctx, key, failuresSoFar) {
  const failures = failuresSoFar + 1
  const lockedUntil = failures >= MAX_FAILURES ? iso(Date.now() + LOCK_MINUTES * 60_000) : null
  await ctx.db.run(
    `INSERT INTO login_attempts (username, ip, failures, locked_until, updated_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (username, ip) DO UPDATE SET
       failures = excluded.failures, locked_until = excluded.locked_until, updated_at = excluded.updated_at`,
    [key.username, key.ip, failures, lockedUntil, now()],
  )
}

export async function login(ctx, req) {
  if (!dashboardEnabled(ctx.env)) fail(404, 'not_found', 'Not found')

  let body
  try {
    body = await req.json()
  } catch {
    fail(400, 'invalid_request', 'Body must be valid JSON')
  }
  const username = String(body?.username ?? '')
  const password = String(body?.password ?? '')

  const key = await attemptKey(ctx, req, username)
  const rows = await ctx.db.all('SELECT * FROM login_attempts WHERE username = ? AND ip = ?', [key.username, key.ip])
  const attempts = rows[0]

  if (attempts?.locked_until && attempts.locked_until > now()) {
    const seconds = Math.ceil((Date.parse(attempts.locked_until) - Date.now()) / 1000)
    return new Response(
      JSON.stringify({ error: { message: 'Too many failed logins. Try again later.', type: 'locked', code: 429 } }),
      { status: 429, headers: { 'content-type': 'application/json', 'retry-after': String(seconds) } },
    )
  }
  // an expired lock starts the count again
  const failuresSoFar = attempts && !attempts.locked_until ? attempts.failures : 0

  const passwordOk = await safeEqual(password, ctx.env.DASHBOARD_PASSWORD)
  if (!key.known || !passwordOk) {
    await recordFailure(ctx, key, failuresSoFar)
    fail(401, 'invalid_credentials', 'Wrong username or password')
  }

  await ctx.db.run('DELETE FROM login_attempts WHERE username = ? AND ip = ?', [key.username, key.ip])

  const token = randomToken()
  const signature = await hmacHex(ctx.env.SESSION_SECRET, token)
  await ctx.db.run('INSERT INTO sessions (token_hash, username, expires_at) VALUES (?, ?, ?)', [
    await sha256(token), // only the hash is stored, a leaked database can't be replayed
    ctx.env.DASHBOARD_USER,
    iso(Date.now() + SESSION_HOURS * 3600_000),
  ])

  return new Response(JSON.stringify({ username: ctx.env.DASHBOARD_USER }), {
    status: 200,
    headers: {
      'content-type': 'application/json',
      'set-cookie': sessionCookie(req, `${token}.${signature}`, SESSION_HOURS * 3600),
    },
  })
}

export async function logout(ctx, req) {
  const cookie = readCookie(req)
  if (cookie) {
    const token = cookie.split('.')[0]
    await ctx.db.run('DELETE FROM sessions WHERE token_hash = ?', [await sha256(token)])
  }
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { 'content-type': 'application/json', 'set-cookie': sessionCookie(req, '', 0) },
  })
}

// housekeeping, called from the tick
export async function pruneAuthTables(ctx) {
  await ctx.db.run('DELETE FROM sessions WHERE expires_at < ?', [now()])
  await ctx.db.run('DELETE FROM login_attempts WHERE updated_at < ?', [iso(Date.now() - 24 * 3600_000)])
}
