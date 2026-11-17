import { openDb } from '../src/db-node.js'
import { migrate } from '../src/store.js'
import { handle } from '../src/app.js'

// app on an in-memory db, plus a `call` helper that goes through the real request handler
export async function makeApp(env = {}) {
  const ctx = {
    env: { API_KEY: 'test-key', ...env },
    db: openDb(':memory:'),
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

  return { ctx, call, settle }
}

export function searchMonitor(overrides = {}) {
  return {
    name: 'AI infra funding',
    targets: [{ type: 'search', query: 'ai infrastructure funding' }],
    schedule: { type: 'interval', interval: '1d' },
    ...overrides,
  }
}
