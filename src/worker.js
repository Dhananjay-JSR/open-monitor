// Cloudflare Workers entrypoint: D1 for storage, a cron trigger for the scheduler.
// LLM_COMMAND is not available here (Workers can't start processes), use LLM_BASE_URL.
import { handle } from './app.js'
import { tick } from './runner.js'
import { migrate } from './store.js'
import { createTelemetry } from './telemetry.js'
import { assembleDashboard } from './dashboard/assemble.js'

// these are bundled as text/bytes by the rules in wrangler.toml
import html from './dashboard/index.html'
import tokensCss from './dashboard/tokens.css'
import appCss from './dashboard/app.css'
import script from './dashboard/app.js'
import geistBytes from './dashboard/fonts/geist-variable.woff2'
import geistMonoBytes from './dashboard/fonts/geist-mono-variable.woff2'

function toBase64(buffer) {
  let binary = ''
  const bytes = new Uint8Array(buffer)
  // in chunks, String.fromCharCode(...bytes) overflows the stack on a 30 KB file
  for (let i = 0; i < bytes.length; i += 8192) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 8192))
  }
  return btoa(binary)
}

const dashboard = assembleDashboard({
  html,
  styles: { 'tokens.css': tokensCss, 'app.css': appCss },
  script,
  fonts: { 'geist-variable.woff2': toBase64(geistBytes), 'geist-mono-variable.woff2': toBase64(geistMonoBytes) },
})

function d1(database) {
  return {
    async all(sql, params = []) {
      const result = await database.prepare(sql).bind(...params).all()
      return result.results
    },
    async run(sql, params = []) {
      const result = await database.prepare(sql).bind(...params).run()
      return result.meta
    },
    async batch(statements) {
      // D1 runs a batch as one transaction
      await database.batch(statements.map(([sql, params]) => database.prepare(sql).bind(...params)))
    },
  }
}

// once per isolate: the schema check, and telemetry (so counters add up across requests)
let migrated = null
let telemetry = null

async function makeContext(env) {
  telemetry ??= createTelemetry(env)
  const ctx = { env, db: d1(env.DB), telemetry, dashboard }
  migrated ??= migrate(ctx.db)
  await migrated
  return ctx
}

export default {
  async fetch(request, env, execution) {
    const ctx = await makeContext(env)
    return handle(ctx, request, (promise) => execution.waitUntil(promise.catch((e) => console.error(e))))
  },

  async scheduled(event, env, execution) {
    execution.waitUntil(makeContext(env).then((ctx) => tick(ctx)))
  },
}
