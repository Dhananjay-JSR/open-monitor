// Node entrypoint: `npm start`
import { createContext, serve } from './server.js'
import { judgeConfigured } from './judge.js'

const env = process.env

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

const ctx = await createContext(env)
serve(ctx, Number(env.PORT ?? 8787))
