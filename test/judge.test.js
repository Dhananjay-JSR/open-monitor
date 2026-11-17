import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { judge, judgeConfigured } from '../src/judge.js'
import { exec } from '../src/exec.js'

// fake OpenAI-compatible server. Replies come from `script`, one entry per request.
async function fakeLlm(script) {
  const requests = []
  const server = createServer(async (req, res) => {
    let body = ''
    for await (const chunk of req) body += chunk
    requests.push({ auth: req.headers.authorization, body: JSON.parse(body) })

    const step = script.shift() ?? { content: '{"score": 0.5}' }
    res.writeHead(step.status ?? 200, { 'content-type': 'application/json', ...step.headers })
    res.end(JSON.stringify({ choices: [{ message: { content: step.content } }] }))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))

  return {
    env: {
      LLM_BASE_URL: `http://127.0.0.1:${server.address().port}/v1`,
      LLM_API_KEY: 'k',
      LLM_MODEL: 'test-model',
    },
    requests,
    close: () => server.close(),
  }
}

const RATE_LIMITED = { status: 429, headers: { 'retry-after': '0' }, content: '' }

test('one request per candidate', async () => {
  const llm = await fakeLlm([
    { content: '{"score": 0.9}' },
    { content: 'Sure! {"score": 0.1}' },
    { content: '0.75' },
  ])
  const scores = await judge({ env: llm.env }, 'find funding news', ['first', 'second', 'third'])
  assert.deepEqual(scores, [0.9, 0.1, 0.75])

  assert.equal(llm.requests.length, 3)
  assert.equal(llm.requests[0].auth, 'Bearer k')
  assert.equal(llm.requests[0].body.model, 'test-model')
  assert.match(llm.requests[1].body.messages[1].content, /Goal: find funding news[\s\S]*second/)
  llm.close()
})

test('a bad reply only affects that candidate', async () => {
  const llm = await fakeLlm([
    { content: 'no idea' },
    { status: 500, content: '' },
    { content: '{"score": 1.5}' },
    { content: '{"score": 0.6}' },
  ])
  assert.deepEqual(await judge({ env: llm.env }, 'g', ['a', 'b', 'c', 'd']), [null, null, null, 0.6])
  llm.close()
})

test('waits out a rate limit', async () => {
  const llm = await fakeLlm([{ content: '{"score": 0.8}' }, RATE_LIMITED, { content: '{"score": 0.7}' }])
  assert.deepEqual(await judge({ env: llm.env }, 'g', ['a', 'b']), [0.8, 0.7])
  assert.equal(llm.requests.length, 3)
  llm.close()
})

test('gives up on the batch when the rate limit persists', async () => {
  const llm = await fakeLlm([{ content: '{"score": 0.8}' }, RATE_LIMITED, RATE_LIMITED, RATE_LIMITED])
  assert.deepEqual(await judge({ env: llm.env }, 'g', ['a', 'b', 'c']), [0.8, null, null])
  assert.equal(llm.requests.length, 4) // 'c' was never sent
  llm.close()
})

test('throws judge_failed when nothing could be judged', async () => {
  const llm = await fakeLlm([{ status: 401, content: '' }])
  await assert.rejects(judge({ env: llm.env }, 'g', ['a']), { code: 'judge_failed', message: /HTTP 401/ })
  llm.close()
})

test('needs some LLM config', async () => {
  await assert.rejects(judge({ env: {} }, 'g', ['a']), { code: 'judge_failed', message: /No LLM is configured/ })
  await assert.rejects(judge({ env: { LLM_COMMAND: 'cat' } }, 'g', ['a']), { code: 'judge_failed', message: /Node server/ })

  assert.equal(judgeConfigured({}), false)
  assert.equal(judgeConfigured({ LLM_COMMAND: 'x' }), true)
  assert.equal(judgeConfigured({ LLM_BASE_URL: 'http://localhost:11434/v1' }), true) // ollama, no key
})

test('command mode gets the prompt on stdin', async () => {
  // the candidate contains shell syntax on purpose, it must arrive as plain text
  const env = {
    LLM_COMMAND: `grep -q 'needle; echo pwned' && echo '{"score": 0.95}' || echo '{"score": 0}'`,
  }
  const scores = await judge({ env, exec }, 'g', ['hay needle; echo pwned hay', 'plain'])
  assert.deepEqual(scores, [0.95, 0])

  await assert.rejects(judge({ env: { LLM_COMMAND: 'exit 3' }, exec }, 'g', ['a']), { code: 'judge_failed' })
})

import { openDb } from '../src/db-node.js'
import { migrate } from '../src/store.js'
import { takeLlmSlot } from '../src/judge.js'

async function limiterCtx(env) {
  const db = openDb(':memory:')
  await migrate(db)
  return { env, db }
}

// pretend `count` calls went out `ageMs` ago
async function fillWindow(db, count, ageMs) {
  for (let i = 0; i < count; i++) {
    await db.run('INSERT INTO llm_calls (id, at) VALUES (?, ?)', [`llm_old${i}`, new Date(Date.now() - ageMs).toISOString()])
  }
}

test('rate limit: under the limit a call goes straight through and is recorded', async () => {
  const ctx = await limiterCtx({ LLM_REQUESTS_PER_MINUTE: '3' })
  await fillWindow(ctx.db, 2, 10_000)
  assert.equal(await takeLlmSlot(ctx), 0)
  assert.equal((await ctx.db.all('SELECT count(*) AS n FROM llm_calls'))[0].n, 3)
})

test('rate limit: when full, a call waits until the oldest slot is a minute old', async () => {
  const ctx = await limiterCtx({ LLM_REQUESTS_PER_MINUTE: '3' })
  await fillWindow(ctx.db, 3, 59_500) // full, and the slots free up in about half a second
  const waited = await takeLlmSlot(ctx)
  assert.ok(waited >= 400 && waited < 2000, `waited ${waited} ms`)
})

test('rate limit: two judges at once share one limit', async () => {
  const ctx = await limiterCtx({ LLM_REQUESTS_PER_MINUTE: '2' })
  await fillWindow(ctx.db, 1, 59_600) // one slot left now, the other frees up in about 0.4 s
  const waits = await Promise.all([takeLlmSlot(ctx), takeLlmSlot(ctx)])
  waits.sort((a, b) => a - b)
  assert.equal(waits[0], 0) // one takes the free slot
  assert.ok(waits[1] >= 300, `second waited ${waits[1]} ms`) // the other has to wait
})

test('rate limit: 0 means unlimited and records nothing; the default is 20', async () => {
  const off = await limiterCtx({ LLM_REQUESTS_PER_MINUTE: '0' })
  await fillWindow(off.db, 50, 1000)
  assert.equal(await takeLlmSlot(off), 0)
  assert.equal((await off.db.all('SELECT count(*) AS n FROM llm_calls'))[0].n, 50)

  const byDefault = await limiterCtx({})
  await fillWindow(byDefault.db, 19, 1000)
  assert.equal(await takeLlmSlot(byDefault), 0) // the 20th call still fits
})

test('rate limit: the judge takes a slot for every call', async () => {
  const llm = await fakeLlm([{ content: '{"score": 0.9}' }, { content: '{"score": 0.1}' }])
  const ctx = await limiterCtx(llm.env)
  ctx.env.LLM_REQUESTS_PER_MINUTE = '5'
  assert.deepEqual(await judge(ctx, 'g', ['a', 'b']), [0.9, 0.1])
  assert.equal((await ctx.db.all('SELECT count(*) AS n FROM llm_calls'))[0].n, 2)
  llm.close()
})
