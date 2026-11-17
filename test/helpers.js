import { createServer } from 'node:http'
import { openDb } from '../src/db-node.js'
import { exec } from '../src/exec.js'
import { migrate } from '../src/store.js'
import { handle } from '../src/app.js'

// Judge stand-in for tests: candidates containing KEEP score high, everything else low.
export const KEEPWORD_JUDGE = `grep -q KEEP && echo '{"score": 0.9}' || echo '{"score": 0.2}'`

// app on an in-memory db, plus a `call` helper that goes through the real request handler
export async function makeApp(env = {}) {
  const ctx = {
    env: { API_KEY: 'test-key', LLM_COMMAND: KEEPWORD_JUDGE, ...env },
    db: openDb(':memory:'),
    exec,
  }
  await migrate(ctx.db)

  const pending = []

  async function call(method, path, body, headers = {}) {
    const req = new Request('http://monitor.test' + path, {
      method,
      headers: { authorization: 'Bearer test-key', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const res = await handle(ctx, req, (promise) => pending.push(promise))
    const text = await res.text()
    let parsed = text
    try {
      parsed = JSON.parse(text)
    } catch {}
    return { status: res.status, body: parsed, headers: res.headers }
  }

  // wait for background work kicked off by requests (manual runs)
  async function settle() {
    while (pending.length) await pending.shift()
  }

  // trigger a manual run and return it once it has finished
  async function runAndWait(monitorId) {
    const queued = await call('POST', `/v1/monitors/${monitorId}/run`)
    await settle()
    return (await call('GET', `/v1/monitors/${monitorId}/runs/${queued.body.id}`)).body
  }

  return { ctx, call, settle, runAndWait }
}

// Local http server standing in for an external service (search api, web page, webhook receiver).
// handler(request) returns { status?, headers?, body } and every request is recorded.
export async function fakeServer(handler) {
  const requests = []
  const server = createServer(async (req, res) => {
    let raw = ''
    for await (const chunk of req) raw += chunk
    const request = { method: req.method, url: req.url, headers: req.headers, raw }
    try {
      request.json = JSON.parse(raw)
    } catch {}
    requests.push(request)

    const reply = (await handler(request)) ?? {}
    const body = typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body ?? {})
    res.writeHead(reply.status ?? 200, reply.headers ?? {})
    res.end(body)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  server.unref() // a failing test shouldn't leave the process hanging on an open server

  return {
    url: `http://127.0.0.1:${server.address().port}`,
    requests,
    close: () => server.close(),
  }
}

export function searchMonitor(overrides = {}) {
  return {
    name: 'AI infra funding',
    targets: [{ type: 'search', query: 'ai infrastructure funding' }],
    schedule: { type: 'interval', interval: '1d' },
    ...overrides,
  }
}
