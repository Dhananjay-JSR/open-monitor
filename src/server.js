// The Node server, split from the entrypoint so it can also be started from other code
// (an add-on can build the context, attach ctx.hooks, and then call serve).
import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'
import { openDb } from './db-node.js'
import { exec } from './exec.js'
import { migrate } from './store.js'
import { handle } from './app.js'
import { tick } from './runner.js'
import { createTelemetry } from './telemetry.js'
import { assembleDashboard } from './dashboard/assemble.js'

// Geist for text, Geist Mono for times, scores and urls
const FONTS = ['geist-variable.woff2', 'geist-mono-variable.woff2']

// the dashboard is one html document with its css, script and fonts inlined
function loadDashboard() {
  const dir = new URL('./dashboard/', import.meta.url)
  const read = (name) => readFileSync(new URL(name, dir), 'utf8')
  return assembleDashboard({
    html: read('index.html'),
    styles: { 'tokens.css': read('tokens.css'), 'app.css': read('app.css') },
    script: read('app.js'),
    fonts: Object.fromEntries(FONTS.map((name) => [name, readFileSync(new URL('fonts/' + name, dir)).toString('base64')])),
  })
}

export async function createContext(env) {
  const ctx = {
    env,
    db: openDb(env.DB_PATH ?? 'monitor.db'),
    exec,
    telemetry: createTelemetry(env),
    dashboard: loadDashboard(),
  }
  await migrate(ctx.db)
  return ctx
}

function background(promise) {
  promise.catch((e) => console.error(e))
}

async function readBody(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  return chunks.length ? Buffer.concat(chunks) : undefined
}

// Starts listening and starts the scheduler timer. Returns the http server.
export function serve(ctx, port) {
  const server = createServer(async (req, res) => {
    try {
      // app.js works with fetch-style Request/Response so it can also run on Workers
      const request = new Request(`http://${req.headers.host ?? 'localhost'}${req.url}`, {
        method: req.method,
        headers: req.headers,
        body: await readBody(req),
      })
      request.ip = req.socket.remoteAddress

      const response = await handle(ctx, request, background)
      res.writeHead(response.status, Object.fromEntries(response.headers))
      res.end(await response.text())
    } catch (e) {
      console.error(e)
      res.writeHead(500).end()
    }
  })

  server.listen(port, () => {
    console.log(`open-monitor listening on http://localhost:${port}`)
  })

  // once a minute. If an external cron also calls POST /tick that's fine, jobs are claimed atomically.
  const timer = setInterval(() => background(tick(ctx)), 60_000)
  server.on('close', () => clearInterval(timer))
  return server
}
