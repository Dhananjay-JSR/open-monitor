// Node entrypoint: http server + a timer that drives the scheduler.
import { createServer } from 'node:http'
import { openDb } from './db-node.js'
import { exec } from './exec.js'
import { migrate } from './store.js'
import { handle } from './app.js'
import { tick } from './runner.js'
import { judgeConfigured } from './judge.js'

const env = process.env
const port = Number(env.PORT ?? 8787)

if (!env.API_KEY) {
  console.error('API_KEY is not set. Pick a long random string and set it before starting.')
  process.exit(1)
}
if (!judgeConfigured(env)) {
  console.warn(
    'warning: no LLM configured (LLM_API_KEY, LLM_BASE_URL or LLM_COMMAND). ' +
      'Every run will fail with judge_failed until one is set.',
  )
}

const ctx = { env, db: openDb(env.DB_PATH ?? 'monitor.db'), exec }
await migrate(ctx.db)

function background(promise) {
  promise.catch((e) => console.error(e))
}

async function readBody(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  return chunks.length ? Buffer.concat(chunks) : undefined
}

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
setInterval(() => background(tick(ctx)), 60_000)
