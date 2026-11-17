import test from 'node:test'
import assert from 'node:assert/strict'
import { makeApp, searchMonitor } from './helpers.js'

test('api key is required', async () => {
  const { call } = await makeApp()

  const wrong = await call('GET', '/v1/monitors', undefined, { authorization: 'Bearer wrong' })
  assert.equal(wrong.status, 401)

  const missing = await call('GET', '/v1/monitors', undefined, { authorization: '' })
  assert.equal(missing.status, 401)
  assert.equal(missing.body.error.type, 'invalid_api_key')
  assert.equal(missing.body.error.code, 401)

  const health = await call('GET', '/health', undefined, { authorization: '' })
  assert.equal(health.status, 200)
})

test('create fills in defaults', async () => {
  const { call } = await makeApp()
  const res = await call('POST', '/v1/monitors', searchMonitor({ metadata: { user: 'u1' } }))
  assert.equal(res.status, 200)

  const m = res.body
  assert.match(m.id, /^mon_/)
  assert.equal(m.object, 'monitor')
  assert.equal(m.goal, '')
  assert.equal(m.status, 'active')
  assert.deepEqual(m.schedule, { type: 'interval', interval: '1d' })
  assert.deepEqual(m.metadata, { user: 'u1' })
  assert.deepEqual(m.targets, [
    {
      type: 'search',
      query: 'ai infrastructure funding',
      max_results: 20,
      filters: { freshness: ['published', 'updated'], include_domains: [], exclude_domains: [] },
    },
  ])
  assert.match(m.next_run_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/)

  // fields that don't apply are left out, not null
  for (const field of ['webhook', 'pause_reason', 'current_run_id', 'last_run']) {
    assert.equal(field in m, false, field)
  }
})

test('generated webhook secret is returned only once', async () => {
  const { call } = await makeApp()
  const created = await call('POST', '/v1/monitors', searchMonitor({ webhook: { url: 'https://hooks.example.com/in' } }))
  assert.match(created.body.webhook.secret, /^whsec_/)
  assert.deepEqual(created.body.webhook.events, ['monitor.changes.detected', 'monitor.paused'])

  const fetched = await call('GET', `/v1/monitors/${created.body.id}`)
  assert.equal('secret' in fetched.body.webhook, false)
})

test('validation errors point at the bad parameter', async () => {
  const { call } = await makeApp()
  const page = (url) => ({ type: 'page', url })
  const search = (extra) => ({ type: 'search', query: 'a', ...extra })

  const cases = [
    [{ ...searchMonitor(), extra: 1 }, 'extra'],
    [searchMonitor({ name: '' }), 'name'],
    [searchMonitor({ targets: [] }), 'targets'],
    [searchMonitor({ targets: [search(), page('https://a.example/')] }), 'targets'],
    [searchMonitor({ targets: [page('https://a.example/'), page('https://a.example/')] }), 'targets'],
    [searchMonitor({ targets: [page('ftp://a.example/')] }), 'targets[0].url'],
    [searchMonitor({ targets: [search({ max_results: 21 })] }), 'targets[0].max_results'],
    [searchMonitor({ targets: [search({ judge: { threshold: 0 } })] }), 'targets[0].judge.threshold'],
    [searchMonitor({ targets: [search({ filters: { include_domains: ['https://a.com'] } })] }), 'targets[0].filters.include_domains[0]'],
    [searchMonitor({ schedule: { type: 'interval', interval: '45d' } }), 'schedule.interval'],
    [searchMonitor({ schedule: { type: 'cron', cron: '0 0 29 2 *' } }), 'schedule.cron'],
    [searchMonitor({ schedule: { type: 'weekly' } }), 'schedule.type'],
    [searchMonitor({ webhook: { url: 'https://h.example/', events: ['monitor.paused', 'nope'] } }), 'webhook.events[1]'],
    [searchMonitor({ webhook: { url: 'https://user:pw@h.example/' } }), 'webhook.url'],
    [searchMonitor({ metadata: { k: 5 } }), 'metadata.k'],
  ]
  for (const [body, param] of cases) {
    const res = await call('POST', '/v1/monitors', body)
    assert.equal(res.status, 400, param)
    assert.equal(res.body.error.type, 'invalid_request')
    assert.equal(res.body.error.param, param)
  }

  const notJson = await call('POST', '/v1/monitors', undefined)
  assert.equal(notJson.status, 400)
})

test('idempotency key', async () => {
  const { call } = await makeApp()
  const headers = { 'idempotency-key': 'abc' }
  const body = searchMonitor({ webhook: { url: 'https://h.example/' } })

  const first = await call('POST', '/v1/monitors', body, headers)
  const repeat = await call('POST', '/v1/monitors', body, headers)
  assert.equal(repeat.body.id, first.body.id)
  assert.equal('secret' in repeat.body.webhook, false)

  const different = await call('POST', '/v1/monitors', searchMonitor({ name: 'other' }), headers)
  assert.equal(different.status, 400)

  const list = await call('GET', '/v1/monitors')
  assert.equal(list.body.data.length, 1)
})

test('patch', async () => {
  const { call, ctx } = await makeApp()
  const created = await call('POST', '/v1/monitors', searchMonitor({ goal: 'g', metadata: { a: '1' } }))
  const path = `/v1/monitors/${created.body.id}`

  let m = (await call('PATCH', path, {
    name: 'renamed',
    goal: null,
    metadata: null,
    schedule: { type: 'cron', cron: '0 9 * * 1-5' },
  })).body
  assert.equal(m.name, 'renamed')
  assert.equal(m.goal, '')
  assert.deepEqual(m.metadata, {})
  assert.deepEqual(m.schedule, { type: 'cron', cron: '0 9 * * 1-5', timezone: 'UTC' })

  // adding a webhook without a secret generates one
  m = (await call('PATCH', path, { webhook: { url: 'https://h.example/', events: ['monitor.run.completed'] } })).body
  assert.match(m.webhook.secret, /^whsec_/)
  const generated = m.webhook.secret

  // sending our own secret rotates: not echoed back, old one kept for 24h
  const mine = 'whsec_' + Buffer.alloc(24, 7).toString('base64')
  m = (await call('PATCH', path, { webhook: { url: 'https://h.example/', secret: mine } })).body
  assert.equal('secret' in m.webhook, false)
  const [row] = await ctx.db.all('SELECT webhook_secret, webhook_old_secret, webhook_old_secret_until FROM monitors')
  assert.equal(row.webhook_secret, mine)
  assert.equal(row.webhook_old_secret, generated)
  assert.ok(row.webhook_old_secret_until > new Date().toISOString())

  m = (await call('PATCH', path, { webhook: null })).body
  assert.equal('webhook' in m, false)

  // status is not writable through PATCH
  assert.equal((await call('PATCH', path, { status: 'paused' })).status, 400)
})

test('list, delete and 404s', async () => {
  const { call } = await makeApp()
  const ids = []
  for (let i = 0; i < 3; i++) {
    ids.push((await call('POST', '/v1/monitors', searchMonitor({ name: `m${i}` }))).body.id)
  }

  const page = (await call('GET', '/v1/monitors?limit=2')).body
  assert.equal(page.object, 'list')
  assert.equal(page.data.length, 2)
  assert.equal(page.has_more, true)

  const rest = (await call('GET', `/v1/monitors?limit=2&after=${page.data[1].id}`)).body
  assert.equal(rest.data.length, 1)
  assert.equal(rest.has_more, false)

  assert.equal((await call('GET', '/v1/monitors?limit=0')).status, 400)

  const deleted = await call('DELETE', `/v1/monitors/${ids[0]}`)
  assert.deepEqual(deleted.body, { id: ids[0], object: 'monitor', deleted: true })
  assert.equal((await call('GET', `/v1/monitors/${ids[0]}`)).status, 404)
  assert.equal((await call('GET', '/v1/nope')).status, 404)
})
