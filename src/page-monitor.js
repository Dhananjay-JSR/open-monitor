// Page monitors: fetch each url, diff its text against the last version we stored,
// and let the judge decide whether the change matters.
import { now, runError } from './util.js'
import { sha256 } from './crypto.js'
import { htmlToText, unifiedDiff } from './text.js'
import { judge } from './judge.js'
import { renderPage } from './cdp.js'

const USER_AGENT = 'Mozilla/5.0 (compatible; open-monitor/0.1)'
const MAX_REDIRECTS = 5
const MAX_TEXT_CHARS = 200_000
const DEFAULT_GOAL = 'Meaningful content changes. Ignore timestamps, counters, ads and layout noise.'

function pageError(code, message, statusCode) {
  const e = new Error(message)
  e.code = code
  if (statusCode) e.statusCode = statusCode
  return e
}

function browserHeaders(env) {
  if (!env.BROWSER_WS_HEADERS) return undefined
  try {
    return JSON.parse(env.BROWSER_WS_HEADERS)
  } catch {
    throw pageError('fetch_unavailable', 'BROWSER_WS_HEADERS is not valid JSON')
  }
}

async function fetchHtml(env, url) {
  if (env.BROWSER_WS_URL) {
    // a real browser, so javascript-rendered pages work
    try {
      return await renderPage(env.BROWSER_WS_URL, url, {
        headers: browserHeaders(env),
        settleMs: env.BROWSER_SETTLE_MS ? Number(env.BROWSER_SETTLE_MS) : undefined,
      })
    } catch (e) {
      if (e.code || e.name === 'TimeoutError') throw e
      throw pageError('fetch_unavailable', `The browser could not load the page: ${e.message}`)
    }
  }

  // redirects are followed by hand so every hop can be checked
  let current = url
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const res = await fetch(current, {
      redirect: 'manual',
      headers: { 'user-agent': USER_AGENT },
      signal: AbortSignal.timeout(20_000),
    })
    const location = res.headers.get('location')
    if (res.status >= 300 && res.status < 400 && location) {
      await res.body?.cancel()
      current = new URL(location, current).href
      continue
    }
    if (!res.ok) {
      await res.body?.cancel()
      throw pageError('http_status', `The page returned HTTP ${res.status}`, res.status)
    }
    return res.text()
  }
  throw pageError('load_failed', 'Too many redirects')
}

function targetError(url, e) {
  let code = e.code
  if (!code) code = e.name === 'TimeoutError' ? 'timeout' : 'load_failed'
  const error = { type: 'page', url, code, message: e.message }
  if (e.statusCode) error.status_code = e.statusCode
  return error
}

function saveBaseline(db, monitorId, url, text, fetchedAt) {
  return db.run(
    `INSERT INTO page_baselines (monitor_id, url, text, fetched_at) VALUES (?, ?, ?, ?)
     ON CONFLICT (monitor_id, url) DO UPDATE SET text = excluded.text, fetched_at = excluded.fetched_at`,
    [monitorId, url, text, fetchedAt],
  )
}

export async function runPages(ctx, monitor, run) {
  const { db } = ctx
  const changed = []

  for (const target of monitor.targets) {
    let html
    try {
      html = await fetchHtml(ctx.env, target.url)
    } catch (e) {
      run.target_errors.push(targetError(target.url, e))
      continue
    }

    const text = htmlToText(html).slice(0, MAX_TEXT_CHARS)
    if (!text) {
      run.target_errors.push(targetError(target.url, pageError('no_content', 'The page has no readable text')))
      continue
    }
    run.usage.fetched_urls++

    const fetchedAt = now()
    const rows = await db.all('SELECT * FROM page_baselines WHERE monitor_id = ? AND url = ?', [monitor.id, target.url])
    const baseline = rows[0]

    if (!baseline || baseline.text === text) {
      // first visit just records the page, an unchanged page only bumps fetched_at
      await saveBaseline(db, monitor.id, target.url, text, fetchedAt)
      continue
    }

    const title = /<title[^>]*>([^<]*)/i.exec(html)
    changed.push({
      target,
      text,
      fetchedAt,
      baseline,
      title: title ? title[1].trim() : '',
      diff: unifiedDiff(baseline.text, text),
    })
  }

  run.counts.errors = run.target_errors.length
  if (run.target_errors.length === monitor.targets.length) {
    throw runError('source_failed', 'None of the pages could be read')
  }
  run.counts.candidates = changed.length
  if (changed.length === 0) return

  const goal = monitor.goal || DEFAULT_GOAL
  const scores = await judge(ctx, goal, changed.map((c) => `Page: ${c.target.url}\nDiff:\n${c.diff.unified}`))

  for (let i = 0; i < changed.length; i++) {
    const page = changed[i]
    const score = scores[i]
    if (score === null) {
      // not judged: keep the old baseline so this change shows up again next run
      run.counts.errors++
      continue
    }

    // judged changes move the baseline forward even when they are rejected,
    // otherwise the same noise would come back every run
    await saveBaseline(db, monitor.id, page.target.url, page.text, page.fetchedAt)
    if (score < (page.target.judge?.threshold ?? 0.5)) continue

    const change = {
      id: 'chg_' + (await sha256(monitor.id + page.target.url + page.fetchedAt)).slice(0, 24),
      type: 'page_change',
      url: page.target.url,
      confidence: score,
      diff: page.diff,
      previous_fetched_at: page.baseline.fetched_at,
      fetched_at: page.fetchedAt,
    }
    if (page.title) change.title = page.title
    run.changes.push(change)
  }
}
