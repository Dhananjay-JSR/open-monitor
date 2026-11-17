import test from 'node:test'
import assert from 'node:assert/strict'
import { makeApp, fakeServer } from './helpers.js'
import { renderPage } from '../src/cdp.js'

// a tiny site whose pages can be edited between runs
async function fakeSite(pages) {
  const site = await fakeServer((req) => {
    const page = pages[req.url]
    if (page === undefined) return { status: 404, body: 'not found' }
    if (typeof page === 'object') return page
    return { headers: { 'content-type': 'text/html' }, body: page }
  })
  return site
}

function html(title, ...lines) {
  return `<html><head><title>${title}</title></head><body>${lines.map((l) => `<p>${l}</p>`).join('')}</body></html>`
}

async function createPageMonitor(call, urls, extra = {}) {
  const res = await call('POST', '/v1/monitors', {
    name: 'changelog',
    targets: urls.map((url) => ({ type: 'page', url })),
    schedule: { type: 'interval', interval: '1d' },
    ...extra,
  })
  assert.equal(res.status, 200, JSON.stringify(res.body))
  return res.body.id
}

test('first run saves a baseline, later runs report judged diffs', async () => {
  const pages = { '/changelog': html('Changelog', 'v1.0 released', 'contact us', 'footer') }
  const site = await fakeSite(pages)
  const { call, runAndWait } = await makeApp()
  const id = await createPageMonitor(call, [site.url + '/changelog'])

  const first = await runAndWait(id)
  assert.equal(first.status, 'succeeded')
  assert.deepEqual(first.counts, { candidates: 0, changes: 0, errors: 0 })
  assert.equal(first.usage.fetched_urls, 1)

  // nothing changed
  const same = await runAndWait(id)
  assert.equal(same.counts.candidates, 0)

  // a change the judge keeps
  pages['/changelog'] = html('Changelog', 'v1.0 released', 'KEEP v2.0 released', 'contact us', 'footer')
  const second = await runAndWait(id)
  assert.deepEqual(second.counts, { candidates: 1, changes: 1, errors: 0 })
  const change = second.changes[0]
  assert.equal(change.type, 'page_change')
  assert.equal(change.url, site.url + '/changelog')
  assert.equal(change.title, 'Changelog')
  assert.equal(change.confidence, 0.9)
  assert.equal(change.diff.unified, '@@ -1,2 +1,3 @@\n v1.0 released\n+KEEP v2.0 released\n contact us\n')
  assert.equal(change.diff.added_lines, 1)
  assert.ok(change.previous_fetched_at <= change.fetched_at)

  // a change the judge rejects still moves the baseline, so it is not reported again
  pages['/changelog'] = html('Changelog', 'v1.0 released', 'KEEP v2.0 released', 'contact us', 'footer 2026')
  const noise = await runAndWait(id)
  assert.deepEqual(noise.counts, { candidates: 1, changes: 0, errors: 0 })
  const after = await runAndWait(id)
  assert.equal(after.counts.candidates, 0)
  site.close()
})

test('unreadable pages are reported per target', async () => {
  const pages = {
    '/ok': html('Ok', 'hello'),
    '/empty': '<html><body><script>1</script></body></html>',
    '/moved': { status: 302, headers: { location: '/ok' }, body: '' },
  }
  const site = await fakeSite(pages)
  const { call, runAndWait } = await makeApp()
  const urls = ['/ok', '/missing', '/empty', '/moved'].map((p) => site.url + p)
  const id = await createPageMonitor(call, urls)

  const run = await runAndWait(id)
  assert.equal(run.status, 'succeeded')
  assert.equal(run.usage.fetched_urls, 2) // /ok and /moved (redirect followed)
  assert.equal(run.counts.errors, 2)
  assert.deepEqual(run.target_errors, [
    { type: 'page', url: site.url + '/missing', code: 'http_status', status_code: 404, message: 'The page returned HTTP 404' },
    { type: 'page', url: site.url + '/empty', code: 'no_content', message: 'The page has no readable text' },
  ])
  site.close()
})

test('run fails with source_failed when no page can be read', async () => {
  const site = await fakeSite({})
  const { call, runAndWait } = await makeApp()
  const id = await createPageMonitor(call, [site.url + '/a', site.url + '/b'])

  const run = await runAndWait(id)
  assert.equal(run.status, 'failed')
  assert.equal(run.error.code, 'source_failed')
  assert.equal(run.target_errors.length, 2)
  site.close()
})

test('removing a page from targets drops its baseline', async () => {
  const site = await fakeSite({ '/a': html('A', 'one'), '/b': html('B', 'two') })
  const { call, runAndWait, ctx } = await makeApp()
  const id = await createPageMonitor(call, [site.url + '/a', site.url + '/b'])
  await runAndWait(id)

  await call('PATCH', `/v1/monitors/${id}`, { targets: [{ type: 'page', url: site.url + '/a' }] })
  const rows = await ctx.db.all('SELECT url FROM page_baselines')
  assert.deepEqual(rows.map((r) => r.url), [site.url + '/a'])
  site.close()
})

// Needs a CDP browser and a page whose content is produced by javascript, e.g.
//   TEST_BROWSER_WS_URL=ws://127.0.0.1:9222/ TEST_JS_PAGE_URL=http://127.0.0.1:8801/index.html
const browser = process.env.TEST_BROWSER_WS_URL
test('renders javascript pages through a CDP browser', { skip: !browser }, async () => {
  const pageUrl = process.env.TEST_JS_PAGE_URL
  const rendered = await renderPage(browser, pageUrl, { settleMs: 800 })
  assert.match(rendered, /RENDERED_BY_JS 42/)

  // and end to end through a page monitor
  const { call, runAndWait, ctx } = await makeApp({ BROWSER_WS_URL: browser })
  const id = await createPageMonitor(call, [pageUrl])
  const run = await runAndWait(id)
  assert.equal(run.status, 'succeeded')
  const [baseline] = await ctx.db.all('SELECT text FROM page_baselines')
  assert.match(baseline.text, /RENDERED_BY_JS 42/)
})
