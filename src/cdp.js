// Tiny Chrome DevTools Protocol client, just enough to load a page and read its HTML after
// scripts have run. Works with anything that speaks CDP over a websocket: Lightpanda,
// Chrome (--remote-debugging-port), Browserless, Cloudflare Browser Run, Kitesurf.

const LOAD_TIMEOUT_MS = 20_000
const TOTAL_TIMEOUT_MS = 45_000

function connect(wsUrl, headers) {
  return new Promise((resolve, reject) => {
    // the headers option is a Node (undici) extension, browsers and Workers don't have it
    const ws = headers ? new WebSocket(wsUrl, { headers }) : new WebSocket(wsUrl)
    ws.addEventListener('open', () => resolve(ws))
    ws.addEventListener('error', () => reject(new Error('could not connect to the browser')))
  })
}

export async function renderPage(wsUrl, pageUrl, options = {}) {
  const ws = await connect(wsUrl, options.headers)
  const pending = new Map()
  const waiters = []
  let nextId = 1

  ws.addEventListener('message', (event) => {
    const message = JSON.parse(event.data)
    if (message.id && pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id)
      pending.delete(message.id)
      if (message.error) reject(new Error(message.error.message ?? 'CDP error'))
      else resolve(message.result)
      return
    }
    for (const waiter of waiters) {
      if (waiter.method === message.method) waiter.resolve(true)
    }
  })

  function send(method, params = {}, sessionId) {
    const id = nextId++
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject })
      ws.send(JSON.stringify({ id, method, params, sessionId }))
    })
  }

  // resolves true when the event arrives, false after the timeout
  function waitFor(method, ms) {
    return new Promise((resolve) => {
      waiters.push({ method, resolve })
      setTimeout(() => resolve(false), ms)
    })
  }

  async function load() {
    const { targetId } = await send('Target.createTarget', { url: 'about:blank' })
    try {
      const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true })
      await send('Page.enable', {}, sessionId)

      const loaded = waitFor('Page.loadEventFired', LOAD_TIMEOUT_MS)
      const nav = await send('Page.navigate', { url: pageUrl }, sessionId)
      if (nav?.errorText) throw new Error(nav.errorText)
      await loaded

      // give client-side rendering a moment after the load event
      await new Promise((resolve) => setTimeout(resolve, options.settleMs ?? 1000))

      const result = await send(
        'Runtime.evaluate',
        { expression: 'document.documentElement.outerHTML', returnByValue: true },
        sessionId,
      )
      return String(result.result?.value ?? '')
    } finally {
      send('Target.closeTarget', { targetId }).catch(() => {})
    }
  }

  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const e = new Error('the browser took too long')
      e.name = 'TimeoutError'
      reject(e)
    }, TOTAL_TIMEOUT_MS)
  })

  try {
    return await Promise.race([load(), timeout])
  } finally {
    clearTimeout(timer)
    ws.close()
  }
}
