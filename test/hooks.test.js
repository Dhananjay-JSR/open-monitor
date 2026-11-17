import test from 'node:test'
import assert from 'node:assert/strict'
import { makeApp, fakeServer, searchMonitor } from './helpers.js'

// a minimal add-on: a read-only "guest" who is recognised by a header
function guestAddon(events) {
  return {
    identify(ctx, req) {
      if (req.headers.get('x-guest') !== 'yes') return null
      return {
        role: 'guest',
        allow: (method) => method === 'GET',
        view: (monitor) => ({ ...monitor, metadata: {}, webhook: undefined }),
      }
    },
    routes(ctx, req) {
      if (new URL(req.url).pathname === '/guest/hello') return new Response('hello guest')
      return null
    },
    onEvent(ctx, monitor, type, run) {
      events.push({ monitor: monitor.id, type, run: run?.id })
    },
  }
}

const guest = { authorization: '', 'x-guest': 'yes' }

test('an add-on identity is limited by allow() and view()', async () => {
  const app = await makeApp()
  app.ctx.hooks = guestAddon([])
  const created = await app.call('POST', '/v1/monitors', searchMonitor({ metadata: { private: 'x' }, webhook: { url: 'https://h.example/secret' } }))
  const id = created.body.id

  const seen = await app.call('GET', `/v1/monitors/${id}`, undefined, guest)
  assert.equal(seen.status, 200)
  assert.deepEqual(seen.body.metadata, {})
  assert.equal('webhook' in seen.body, false)
  const list = await app.call('GET', '/v1/monitors', undefined, guest)
  assert.equal('webhook' in list.body.data[0], false)

  for (const [method, path, body] of [
    ['POST', '/v1/monitors', searchMonitor()],
    ['PATCH', `/v1/monitors/${id}`, { name: 'x' }],
    ['DELETE', `/v1/monitors/${id}`],
    ['POST', `/v1/monitors/${id}/pause`],
    ['POST', `/v1/monitors/${id}/run`],
    ['POST', '/tick'],
  ]) {
    const res = await app.call(method, path, body, guest)
    assert.equal(res.status, 403, `${method} ${path}`)
    assert.equal(res.body.error.type, 'forbidden')
  }

  // the owner still sees everything, and strangers are still rejected
  assert.deepEqual((await app.call('GET', `/v1/monitors/${id}`)).body.metadata, { private: 'x' })
  assert.equal((await app.call('GET', '/v1/monitors', undefined, { authorization: '' })).status, 401)
})

test('add-on routes and events', async () => {
  const events = []
  const tavily = await fakeServer(() => ({ body: { results: [{ title: 't', url: 'https://a.example.com/1', content: 'KEEP' }] } }))
  const app = await makeApp({ TAVILY_API_KEY: 'k', TAVILY_URL: tavily.url })
  app.ctx.hooks = guestAddon(events)

  const hello = await app.call('GET', '/guest/hello', undefined, { authorization: '' })
  assert.equal(hello.body, 'hello guest')

  // no webhook on the monitor, the hook still hears about every event
  const id = (await app.call('POST', '/v1/monitors', searchMonitor())).body.id
  const run = await app.runAndWait(id)
  assert.deepEqual(events, [
    { monitor: id, type: 'monitor.changes.detected', run: run.id },
    { monitor: id, type: 'monitor.run.completed', run: run.id },
  ])

  // a hook that throws does not break the run
  app.ctx.hooks.onEvent = () => {
    throw new Error('boom')
  }
  const original = console.error
  console.error = () => {}
  const second = await app.runAndWait(id)
  console.error = original
  assert.equal(second.status, 'succeeded')
})

test('dashboardExtra is appended to the page', async () => {
  const app = await makeApp({ DASHBOARD_USER: 'a', DASHBOARD_PASSWORD: 'b', SESSION_SECRET: 'c' })
  app.ctx.dashboard = '<html><body><main></main></body></html>'
  app.ctx.dashboardExtra = '<script>window.addon = true</script>'
  const page = await app.call('GET', '/', undefined, { authorization: '' })
  assert.equal(page.body, '<html><body><main></main><script>window.addon = true</script></body></html>')
})
