// Search monitors: run the query, drop what we've already looked at, let the judge decide.
import { iso, runError } from './util.js'
import { sha256 } from './crypto.js'
import { judge } from './judge.js'

const DAY_MS = 24 * 60 * 60 * 1000
const DEFAULT_GOAL = 'Results that are relevant to the search query and substantive.'

function hostname(url) {
  try {
    return new URL(url).hostname
  } catch {
    return ''
  }
}

// true if host is one of the domains or a subdomain of one
function matchesDomain(host, domains) {
  return domains.some((d) => host === d || host.endsWith('.' + d))
}

async function searxng(env, target, days) {
  // not every engine behind searxng understands "week", so anything up to a month uses "month"
  const range = days <= 1 ? 'day' : days <= 31 ? 'month' : 'year'
  const params = new URLSearchParams({ q: target.query, format: 'json', time_range: range })
  const base = env.SEARXNG_URL.replace(/\/+$/, '')
  return fetch(`${base}/search?${params}`, { signal: AbortSignal.timeout(30_000) })
}

async function tavily(env, target, days) {
  let range = 'year'
  if (days <= 1) range = 'day'
  else if (days <= 7) range = 'week'
  else if (days <= 31) range = 'month'

  const base = (env.TAVILY_URL ?? 'https://api.tavily.com').replace(/\/+$/, '')
  return fetch(`${base}/search`, {
    method: 'POST',
    signal: AbortSignal.timeout(30_000),
    headers: {
      authorization: `Bearer ${env.TAVILY_API_KEY}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      query: target.query,
      max_results: target.max_results,
      time_range: range,
      include_domains: target.filters.include_domains,
      exclude_domains: target.filters.exclude_domains,
      // without this Tavily leaves out publish dates, and the window filter can't drop old results
      include_published_date: true,
    }),
  })
}

// SearXNG wins if both are configured. Both return { results: [...] } with slightly different date fields.
async function search(env, target, window) {
  const days = (Date.parse(window.to) - Date.parse(window.from)) / DAY_MS

  let res
  try {
    if (env.SEARXNG_URL) res = await searxng(env, target, days)
    else if (env.TAVILY_API_KEY) res = await tavily(env, target, days)
  } catch (e) {
    throw runError('detect_failed', `The search request failed: ${e.message}`)
  }
  if (!res) {
    throw runError('detect_failed', 'Set SEARXNG_URL or TAVILY_API_KEY to run search monitors')
  }
  if (!res.ok) throw runError('detect_failed', `The search provider returned HTTP ${res.status}`)

  let data
  try {
    data = await res.json()
  } catch {
    throw runError('detect_failed', 'The search provider did not return JSON')
  }

  return (data.results ?? []).slice(0, target.max_results).map((r) => ({
    url: String(r.url ?? ''),
    title: String(r.title ?? ''),
    content: String(r.content ?? ''),
    date: r.published_date ?? r.publishedDate ?? null,
  }))
}

function applyFilters(results, filters, windowFrom) {
  const kept = []
  for (const result of results) {
    const host = hostname(result.url)
    if (!host) continue
    if (kept.some((r) => r.url === result.url)) continue
    if (filters.include_domains.length && !matchesDomain(host, filters.include_domains)) continue
    if (matchesDomain(host, filters.exclude_domains)) continue
    // dated before the window means it isn't new. Results without a date get the benefit of the doubt.
    if (Date.parse(result.date) < windowFrom) continue
    kept.push(result)
  }
  return kept
}

export async function runSearch(ctx, monitor, run) {
  const { db } = ctx
  const target = monitor.targets[0]

  const provider = ctx.env.SEARXNG_URL ? 'searxng' : 'tavily'
  const span = ctx.telemetry.startSpan('search', { 'search.provider': provider }, run.span)
  let results
  try {
    results = await search(ctx.env, target, run.window)
    span.end({ 'search.results': results.length })
  } catch (e) {
    span.end({}, e.message)
    throw e
  }
  const fresh = applyFilters(results, target.filters, Date.parse(run.window.from))
  if (fresh.length === 0) return

  const marks = fresh.map(() => '?').join(',')
  const seenRows = await db.all(
    `SELECT url FROM seen_urls WHERE monitor_id = ? AND url IN (${marks})`,
    [monitor.id, ...fresh.map((r) => r.url)],
  )
  const seen = new Set(seenRows.map((row) => row.url))
  const candidates = fresh.filter((r) => !seen.has(r.url))
  run.counts.candidates = candidates.length
  if (candidates.length === 0) return

  const goal = `${monitor.goal || DEFAULT_GOAL}\nSearch query: ${target.query}`
  const scores = await judge(ctx, goal, candidates.map((c) => `${c.title}\n${c.url}\n${c.content}`), run.span)
  const threshold = target.judge?.threshold ?? 0.5

  for (let i = 0; i < candidates.length; i++) {
    const candidate = candidates[i]
    const score = scores[i]
    if (score === null) {
      // couldn't be judged, leave it unseen so the next run picks it up again
      run.counts.errors++
      continue
    }

    // remember it whether it passed or not, each url is judged once
    await db.run('INSERT OR IGNORE INTO seen_urls (monitor_id, url) VALUES (?, ?)', [monitor.id, candidate.url])
    if (score < threshold) continue

    const change = {
      id: 'chg_' + (await sha256(monitor.id + candidate.url)).slice(0, 24),
      type: 'search_result',
      url: candidate.url,
      confidence: score,
    }
    if (candidate.title) change.title = candidate.title
    if (candidate.content) change.snippet = candidate.content.slice(0, 500)
    const publishedMs = Date.parse(candidate.date)
    if (publishedMs) change.published_at = iso(publishedMs)
    run.changes.push(change)
  }
}
