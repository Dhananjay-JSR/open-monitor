import test from 'node:test'
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { makeApp, fakeServer, searchMonitor } from './helpers.js'

const RESULTS = [
  { title: 'Big round', url: 'https://news.example.com/big-round', content: 'KEEP: $2B for GPUs' },
  { title: 'Listicle', url: 'https://blog.example.org/top-10', content: 'ten ai tools' },
]

// what a receiver following the Standard Webhooks spec would do
function verify(request, secret) {
  const id = request.headers['webhook-id']
  const timestamp = request.headers['webhook-timestamp']
  const key = Buffer.from(secret.slice('whsec_'.length), 'base64')
  const expected = 'v1,' + createHmac('sha256', key).update(`${id}.${timestamp}.${request.raw}`).digest('base64')
  return request.headers['webhook-signature'].split(' ').includes(expected)
}

async function setup(receiverReply = () => ({ status: 200 }), events) {
  const tavily = await fakeServer(() => ({ body: { results: RESULTS } }))
  const receiver = await fakeServer(receiverReply)
  const app = await makeApp({ TAVILY_API_KEY: 'k', TAVILY_URL: tavily.url })
  const webhook = { url: receiver.url + '/hook' }
  if (events) webhook.events = events
  const created = await app.call('POST', '/v1/monitors', searchMonitor({ webhook, metadata: { user: 'u1' } }))
  assert.equal(created.status, 200, JSON.stringify(created.body))
  return { ...app, tavily, receiver, id: created.body.id, secret: created.body.webhook.secret }
}

// make every queued delivery due now, then run a tick
async function flush(app) {
  await app.ctx.db.run(`UPDATE deliveries SET next_at = '2026-01-01T00:00:00Z'`)
  await app.call('POST', '/tick')
}

test('changes.detected is delivered and signed', async () => {
  const app = await setup()
  const run = await app.runAndWait(app.id)
  assert.equal(run.counts.changes, 1)

  assert.equal(app.receiver.requests.length, 1)
  const request = app.receiver.requests[0]
  assert.equal(request.url, '/hook')
  assert.ok(verify(request, app.secret), 'signature should verify')
  assert.ok(Math.abs(Date.now() / 1000 - Number(request.headers['webhook-timestamp'])) < 5)

  const event = request.json
  assert.match(event.id, /^evt_/)
  assert.equal(event.id, request.headers['webhook-id'])
  assert.equal(event.object, 'event')
  assert.equal(event.type, 'monitor.changes.detected')
  assert.deepEqual(event.data.monitor, {
    id: app.id,
    name: 'AI infra funding',
    status: 'active',
    metadata: { user: 'u1' },
  })
  assert.deepEqual(event.data.run, run) // same object as GET /runs/{id}

  // a run with nothing new sends nothing by default
  await app.runAndWait(app.id)
  assert.equal(app.receiver.requests.length, 1)
})

test('run.completed is only sent when subscribed', async () => {
  const app = await setup(undefined, ['monitor.run.completed'])
  await app.runAndWait(app.id)
  await app.runAndWait(app.id) // no changes this time, still completes

  const types = app.receiver.requests.map((r) => r.json.type)
  assert.deepEqual(types, ['monitor.run.completed', 'monitor.run.completed'])
  assert.equal(app.receiver.requests[1].json.data.run.counts.changes, 0)
})

test('5xx is retried with the same event id', async () => {
  let calls = 0
  const app = await setup(() => ({ status: ++calls === 1 ? 500 : 200 }))
  await app.runAndWait(app.id)
  assert.equal(app.receiver.requests.length, 1)

  const [queued] = await app.ctx.db.all('SELECT attempt, next_at FROM deliveries')
  assert.equal(queued.attempt, 1)
  assert.ok(queued.next_at > new Date().toISOString().slice(0, 19) + 'Z') // retry is in the future

  await flush(app)
  assert.equal(app.receiver.requests.length, 2)
  assert.equal(app.receiver.requests[0].headers['webhook-id'], app.receiver.requests[1].headers['webhook-id'])
  assert.equal((await app.ctx.db.all('SELECT * FROM deliveries')).length, 0)
  assert.equal((await app.call('GET', `/v1/monitors/${app.id}`)).body.status, 'active')
})

test('a 4xx is retried like any other failure, and only the 7th failure pauses', async () => {
  const app = await setup(() => ({ status: 410 }))
  await app.runAndWait(app.id)

  // first failure: the monitor keeps running, the event waits for its retry
  let monitor = (await app.call('GET', `/v1/monitors/${app.id}`)).body
  assert.equal(monitor.status, 'active')
  const [queued] = await app.ctx.db.all('SELECT attempt FROM deliveries')
  assert.equal(queued.attempt, 1)

  for (let i = 0; i < 5; i++) await flush(app)
  monitor = (await app.call('GET', `/v1/monitors/${app.id}`)).body
  assert.equal(monitor.status, 'active') // 6 failures, still running

  await flush(app) // 7th attempt
  monitor = (await app.call('GET', `/v1/monitors/${app.id}`)).body
  assert.equal(monitor.status, 'paused')
  assert.equal(monitor.pause_reason, 'webhook_failing')
  assert.equal('next_run_at' in monitor, false)

  const detected = app.receiver.requests.filter((r) => r.json.type === 'monitor.changes.detected')
  assert.equal(detected.length, 7)
  // monitor.paused goes to the same (dead) endpoint, best effort
  await flush(app)
  assert.ok(app.receiver.requests.some((r) => r.json.type === 'monitor.paused'))
})

test('an outage shorter than the retries never pauses the monitor', async () => {
  let calls = 0
  const app = await setup(() => ({ status: ++calls <= 4 ? 503 : 200 })) // down for 4 attempts
  await app.runAndWait(app.id)
  for (let i = 0; i < 4; i++) await flush(app)

  assert.equal(app.receiver.requests.length, 5)
  assert.equal(app.receiver.requests.at(-1).headers['webhook-id'], app.receiver.requests[0].headers['webhook-id'])
  assert.equal((await app.ctx.db.all('SELECT * FROM deliveries')).length, 0) // delivered on the 5th try
  assert.equal((await app.call('GET', `/v1/monitors/${app.id}`)).body.status, 'active')

  // and runs carry on as normal
  const next = await app.runAndWait(app.id)
  assert.equal(next.status, 'succeeded')
})

test('gives up after seven attempts', async () => {
  const app = await setup(() => ({ status: 503 }))
  await app.runAndWait(app.id)
  for (let i = 0; i < 6; i++) await flush(app)

  const detected = app.receiver.requests.filter((r) => r.json.type === 'monitor.changes.detected')
  assert.equal(detected.length, 7)
  assert.equal((await app.call('GET', `/v1/monitors/${app.id}`)).body.pause_reason, 'webhook_failing')
})

test('during rotation both secrets sign', async () => {
  const app = await setup()
  const newSecret = 'whsec_' + Buffer.alloc(32, 9).toString('base64')
  await app.call('PATCH', `/v1/monitors/${app.id}`, { webhook: { url: app.receiver.url + '/hook', secret: newSecret } })
  await app.runAndWait(app.id)

  const request = app.receiver.requests[0]
  assert.equal(request.headers['webhook-signature'].split(' ').length, 2)
  assert.ok(verify(request, newSecret))
  assert.ok(verify(request, app.secret))
})

test('webhook test endpoint', async () => {
  const app = await setup()
  const ok = (await app.call('POST', `/v1/monitors/${app.id}/webhook/test`)).body
  assert.equal(ok.object, 'monitor.webhook_test')
  assert.equal(ok.delivered, true)
  assert.equal(ok.status_code, 200)
  assert.equal(typeof ok.duration_ms, 'number')

  const event = app.receiver.requests[0].json
  assert.equal(event.type, 'monitor.webhook.test')
  assert.equal(event.id, ok.event_id)
  assert.equal('run' in event.data, false)
  assert.ok(verify(app.receiver.requests[0], app.secret))

  // receiver that answers with a redirect: reported, not followed
  const redirecting = await setup(() => ({ status: 302, headers: { location: 'http://127.0.0.1:1/' } }))
  const failed = (await redirecting.call('POST', `/v1/monitors/${redirecting.id}/webhook/test`)).body
  assert.equal(failed.delivered, false)
  assert.equal(failed.error, 'http_status')
  assert.equal(failed.status_code, 302)

  // no webhook configured
  const plain = (await app.call('POST', '/v1/monitors', searchMonitor())).body
  assert.equal((await app.call('POST', `/v1/monitors/${plain.id}/webhook/test`)).status, 409)
})

test('five source failures in a row pause the monitor', async () => {
  const receiver = await fakeServer(() => ({ status: 200 }))
  const broken = await fakeServer(() => ({ status: 500, body: 'down' }))
  const app = await makeApp({ TAVILY_API_KEY: 'k', TAVILY_URL: broken.url })
  const id = (await app.call('POST', '/v1/monitors', searchMonitor({ webhook: { url: receiver.url } }))).body.id

  for (let i = 0; i < 4; i++) await app.runAndWait(id)
  assert.equal((await app.call('GET', `/v1/monitors/${id}`)).body.status, 'active')

  const fifth = await app.runAndWait(id)
  const monitor = (await app.call('GET', `/v1/monitors/${id}`)).body
  assert.equal(monitor.status, 'paused')
  assert.equal(monitor.pause_reason, 'source_failing')

  await flush(app)
  const paused = receiver.requests.find((r) => r.json.type === 'monitor.paused')
  assert.equal(paused.json.data.run.id, fifth.id)

  // resuming clears the streak
  await app.call('POST', `/v1/monitors/${id}/resume`)
  await app.runAndWait(id)
  assert.equal((await app.call('GET', `/v1/monitors/${id}`)).body.status, 'active')
})
