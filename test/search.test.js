import test from 'node:test'
import assert from 'node:assert/strict'
import { makeApp, fakeServer, searchMonitor } from './helpers.js'

const RESULTS = [
  { title: 'Big round', url: 'https://news.example.com/big-round', content: 'KEEP: $2B for GPUs' },
  { title: 'Listicle', url: 'https://blog.example.org/top-10', content: 'ten ai tools' },
  { title: 'Big round (dup)', url: 'https://news.example.com/big-round', content: 'KEEP again' },
  { title: 'Spam', url: 'https://spam.example.net/x', content: 'KEEP but excluded' },
]

async function createMonitor(call, overrides) {
  return (await call('POST', '/v1/monitors', searchMonitor(overrides))).body.id
}

test('tavily search monitor', async () => {
  const tavily = await fakeServer(() => ({ body: { results: RESULTS } }))
  const { call, runAndWait } = await makeApp({ TAVILY_API_KEY: 'tvly-test', TAVILY_URL: tavily.url })
  const id = await createMonitor(call, {
    goal: 'funding rounds',
    targets: [
      {
        type: 'search',
        query: 'ai infrastructure funding',
        max_results: 10,
        filters: { exclude_domains: ['example.net'] },
      },
    ],
  })

  const run = await runAndWait(id)
  assert.equal(run.status, 'succeeded')
  // 4 results: one duplicate url, one excluded domain -> 2 candidates, judge keeps one
  assert.deepEqual(run.counts, { candidates: 2, changes: 1, errors: 0 })
  assert.equal(run.changes[0].type, 'search_result')
  assert.equal(run.changes[0].url, 'https://news.example.com/big-round')
  assert.equal(run.changes[0].title, 'Big round')
  assert.equal(run.changes[0].snippet, 'KEEP: $2B for GPUs')
  assert.equal(run.changes[0].confidence, 0.9)
  assert.match(run.changes[0].id, /^chg_[0-9a-f]{24}$/)

  const sent = tavily.requests[0]
  assert.equal(sent.url, '/search')
  assert.equal(sent.headers.authorization, 'Bearer tvly-test')
  assert.equal(sent.json.query, 'ai infrastructure funding')
  assert.equal(sent.json.max_results, 10)
  assert.equal(sent.json.time_range, 'week') // a first run looks back 7 days
  assert.deepEqual(sent.json.exclude_domains, ['example.net'])
  assert.equal(sent.json.include_published_date, true)

  // second run: both urls were judged already (kept or not), so nothing is new
  const second = await runAndWait(id)
  assert.deepEqual(second.counts, { candidates: 0, changes: 0, errors: 0 })
  tavily.close()
})

test('searxng is used when SEARXNG_URL is set', async () => {
  const lastYear = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString()
  const searx = await fakeServer(() => ({
    body: {
      results: [
        { title: 'Fresh', url: 'https://a.example.com/fresh', content: 'KEEP me', publishedDate: new Date().toISOString() },
        { title: 'Old', url: 'https://a.example.com/old', content: 'KEEP me too', publishedDate: lastYear },
        { title: 'Other site', url: 'https://b.example.com/x', content: 'KEEP' },
      ],
    },
  }))
  const { call, runAndWait } = await makeApp({ SEARXNG_URL: searx.url + '/', TAVILY_API_KEY: 'unused' })
  const id = await createMonitor(call, {
    targets: [{ type: 'search', query: 'q', filters: { include_domains: ['example.com'] } }],
    schedule: { type: 'interval', interval: '1w' },
  })

  const run = await runAndWait(id)
  // the year-old result is outside the window
  assert.deepEqual(run.changes.map((c) => c.url), ['https://a.example.com/fresh', 'https://b.example.com/x'])
  assert.ok(run.changes[0].published_at)

  const url = new URL(searx.requests[0].url, searx.url)
  assert.equal(url.pathname, '/search')
  assert.equal(url.searchParams.get('q'), 'q')
  assert.equal(url.searchParams.get('format'), 'json')
  assert.equal(url.searchParams.get('time_range'), 'month')
  searx.close()
})

test('per-target threshold', async () => {
  const tavily = await fakeServer(() => ({ body: { results: RESULTS.slice(0, 2) } }))
  const { call, runAndWait } = await makeApp({ TAVILY_API_KEY: 'k', TAVILY_URL: tavily.url })

  const strict = await createMonitor(call, { targets: [{ type: 'search', query: 'q', judge: { threshold: 0.95 } }] })
  assert.equal((await runAndWait(strict)).counts.changes, 0)

  const loose = await createMonitor(call, { targets: [{ type: 'search', query: 'q', judge: { threshold: 0.1 } }] })
  assert.equal((await runAndWait(loose)).counts.changes, 2)
  tavily.close()
})

test('search failures fail the run with detect_failed', async () => {
  const broken = await fakeServer(() => ({ status: 503, body: 'down' }))
  const { call, runAndWait } = await makeApp({ TAVILY_API_KEY: 'k', TAVILY_URL: broken.url })
  const id = await createMonitor(call)
  const run = await runAndWait(id)
  assert.equal(run.status, 'failed')
  assert.equal(run.error.code, 'detect_failed')
  assert.match(run.error.message, /503/)
  broken.close()

  const noProvider = await makeApp()
  const other = await createMonitor(noProvider.call)
  const run2 = await noProvider.runAndWait(other)
  assert.equal(run2.error.code, 'detect_failed')
  assert.match(run2.error.message, /SEARXNG_URL or TAVILY_API_KEY/)
})

test('unjudged candidates are retried on the next run', async () => {
  const tavily = await fakeServer(() => ({ body: { results: RESULTS.slice(0, 2) } }))
  // judge that answers garbage for the listicle and a score for the rest
  const flaky = `grep -q KEEP && echo '{"score": 0.9}' || echo 'no idea'`
  const { call, runAndWait, ctx } = await makeApp({ TAVILY_API_KEY: 'k', TAVILY_URL: tavily.url, LLM_COMMAND: flaky })
  const id = await createMonitor(call)

  const first = await runAndWait(id)
  assert.deepEqual(first.counts, { candidates: 2, changes: 1, errors: 1 })

  ctx.env.LLM_COMMAND = `echo '{"score": 0.8}'`
  const second = await runAndWait(id)
  assert.deepEqual(second.counts, { candidates: 1, changes: 1, errors: 0 })
  assert.equal(second.changes[0].url, 'https://blog.example.org/top-10')
  tavily.close()
})

test('no LLM configured fails the run', async () => {
  const { call, runAndWait } = await makeApp({ LLM_COMMAND: '', TAVILY_API_KEY: 'k' })
  const id = await createMonitor(call)
  const run = await runAndWait(id)
  assert.equal(run.status, 'failed')
  assert.equal(run.error.code, 'judge_failed')
})

test('a first run looks back 7 days, and findings come newest first', async () => {
  const day = 24 * 60 * 60 * 1000
  const at = (daysAgo) => new Date(Date.now() - daysAgo * day).toISOString()
  const searx = await fakeServer(() => ({
    body: {
      results: [
        { title: 'Older', url: 'https://a.example.com/older', content: 'KEEP', publishedDate: at(5) },
        { title: 'Undated', url: 'https://a.example.com/undated', content: 'KEEP' },
        { title: 'Newest', url: 'https://a.example.com/newest', content: 'KEEP', publishedDate: at(1) },
        { title: 'Too old', url: 'https://a.example.com/too-old', content: 'KEEP', publishedDate: at(9) },
      ],
    },
  }))
  const { call, runAndWait } = await makeApp({ SEARXNG_URL: searx.url, TAVILY_API_KEY: 'unused' })
  // a 15 minute schedule still starts with the past week
  const id = await createMonitor(call, { schedule: { type: 'interval', interval: '15m' } })
  const run = await runAndWait(id)
  assert.equal(Date.parse(run.window.to) - Date.parse(run.window.from) >= 7 * day, true)
  assert.deepEqual(run.changes.map((c) => c.title), ['Newest', 'Older', 'Undated'])
  searx.close()
})
