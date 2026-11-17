import test from 'node:test'
import assert from 'node:assert/strict'
import { makeApp, searchMonitor } from './helpers.js'

const DASHBOARD = { DASHBOARD_USER: 'admin', DASHBOARD_PASSWORD: 'correct horse', SESSION_SECRET: 'sssh' }

async function makeDashboardApp(env = {}) {
  const app = await makeApp({ ...DASHBOARD, ...env })
  app.ctx.dashboard = '<!doctype html><title>dashboard</title>'
  // like `call`, but without the API key header
  app.browser = (method, path, body, headers = {}) => app.call(method, path, body, { authorization: '', ...headers })
  app.login = (username, password, headers) => app.browser('POST', '/auth/login', { username, password }, headers)
  return app
}

function cookieFrom(res) {
  return res.headers.get('set-cookie').split(';')[0]
}

test('dashboard is off unless user, password and secret are all set', async () => {
  for (const missing of Object.keys(DASHBOARD)) {
    const app = await makeDashboardApp({ [missing]: '' })
    assert.equal((await app.browser('GET', '/')).status, 404, missing)
    assert.equal((await app.login('admin', 'correct horse')).status, 404, missing)
  }
  const app = await makeDashboardApp()
  const page = await app.browser('GET', '/')
  assert.equal(page.status, 200)
  assert.match(page.headers.get('content-type'), /text\/html/)
  assert.match(page.headers.get('content-security-policy'), /default-src 'none'/)
})

test('login sets a session cookie that works for the api', async () => {
  const app = await makeDashboardApp()
  assert.equal((await app.browser('GET', '/auth/session')).status, 401)
  assert.equal((await app.browser('GET', '/v1/monitors')).status, 401)

  const res = await app.login('admin', 'correct horse')
  assert.equal(res.status, 200)
  const setCookie = res.headers.get('set-cookie')
  assert.match(setCookie, /^om_session=[0-9a-f]{64}\.[0-9a-f]{64}; Path=\/; HttpOnly; SameSite=Strict; Max-Age=43200$/)
  const cookie = cookieFrom(res)

  const session = await app.browser('GET', '/auth/session', undefined, { cookie })
  assert.deepEqual(session.body, { username: 'admin', judge_configured: true })

  const created = await app.browser('POST', '/v1/monitors', searchMonitor(), { cookie, 'sec-fetch-site': 'same-origin' })
  assert.equal(created.status, 200)
  assert.equal((await app.browser('GET', '/v1/monitors', undefined, { cookie })).body.data.length, 1)

  // only a hash of the token is stored
  const [row] = await app.ctx.db.all('SELECT * FROM sessions')
  assert.equal(cookie.includes(row.token_hash), false)
})

test('cookie gets the Secure flag over https', async () => {
  const app = await makeDashboardApp()
  const res = await app.login('admin', 'correct horse', { 'x-forwarded-proto': 'https' })
  assert.match(res.headers.get('set-cookie'), /; Secure$/)
})

test('tampered, expired and logged-out sessions are rejected', async () => {
  const app = await makeDashboardApp()
  const cookie = cookieFrom(await app.login('admin', 'correct horse'))
  const [token, signature] = cookie.replace('om_session=', '').split('.')

  const forged = `om_session=${'0'.repeat(64)}.${signature}`
  assert.equal((await app.browser('GET', '/v1/monitors', undefined, { cookie: forged })).status, 401)
  assert.equal((await app.browser('GET', '/v1/monitors', undefined, { cookie: `om_session=${token}` })).status, 401)

  await app.ctx.db.run(`UPDATE sessions SET expires_at = '2026-01-01T00:00:00Z'`)
  assert.equal((await app.browser('GET', '/v1/monitors', undefined, { cookie })).status, 401)
  await app.call('POST', '/tick')
  assert.equal((await app.ctx.db.all('SELECT * FROM sessions')).length, 0) // pruned

  const fresh = cookieFrom(await app.login('admin', 'correct horse'))
  const out = await app.browser('POST', '/auth/logout', undefined, { cookie: fresh })
  assert.match(out.headers.get('set-cookie'), /Max-Age=0/)
  assert.equal((await app.browser('GET', '/auth/session', undefined, { cookie: fresh })).status, 401)
})

test('cross-site requests with the session cookie are refused', async () => {
  const app = await makeDashboardApp()
  const cookie = cookieFrom(await app.login('admin', 'correct horse'))
  const res = await app.browser('POST', '/v1/monitors', searchMonitor(), { cookie, 'sec-fetch-site': 'cross-site' })
  assert.equal(res.status, 403)
  // the api key is not affected by this
  assert.equal((await app.call('POST', '/v1/monitors', searchMonitor(), { 'sec-fetch-site': 'cross-site' })).status, 200)
})

test('five failed logins lock that username and ip for 15 minutes', async () => {
  const app = await makeDashboardApp()
  for (let i = 0; i < 5; i++) {
    const res = await app.login('admin', 'wrong')
    assert.equal(res.status, 401)
    assert.equal(res.body.error.type, 'invalid_credentials')
  }

  // locked now, even with the right password
  const locked = await app.login('admin', 'correct horse')
  assert.equal(locked.status, 429)
  const retryAfter = Number(locked.headers.get('retry-after'))
  assert.ok(retryAfter > 14 * 60 && retryAfter <= 15 * 60)

  // a different ip is not locked out (needs TRUST_PROXY to be told apart here)
  app.ctx.env.TRUST_PROXY = '1'
  const other = await app.login('admin', 'correct horse', { 'x-forwarded-for': '203.0.113.9' })
  assert.equal(other.status, 200)
  app.ctx.env.TRUST_PROXY = ''

  // once the lock expires the count starts over
  await app.ctx.db.run(`UPDATE login_attempts SET locked_until = '2026-01-01T00:00:00Z'`)
  assert.equal((await app.login('admin', 'wrong')).status, 401)
  assert.equal((await app.login('admin', 'correct horse')).status, 200)
  assert.equal((await app.ctx.db.all('SELECT * FROM login_attempts')).length, 0)
})

test('wrong usernames share one lockout bucket per ip', async () => {
  const app = await makeDashboardApp()
  for (const name of ['root', 'test', 'administrator', 'a', 'b']) {
    assert.equal((await app.login(name, 'correct horse')).status, 401)
  }
  const rows = await app.ctx.db.all('SELECT username, failures FROM login_attempts')
  assert.deepEqual(rows.map((r) => ({ ...r })), [{ username: '*', failures: 5 }])
  assert.equal((await app.login('someone', 'x')).status, 429)
  // the real account is a separate bucket and still works
  assert.equal((await app.login('admin', 'correct horse')).status, 200)
})
