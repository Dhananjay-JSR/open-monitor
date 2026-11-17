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
