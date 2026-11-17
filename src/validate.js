// Request validation. Limits follow the Perplexity Monitor API reference.
import { parseInterval, formatInterval, nextRun } from './schedule.js'

export const EVENT_TYPES = ['monitor.changes.detected', 'monitor.run.completed', 'monitor.paused']
const DEFAULT_EVENTS = ['monitor.changes.detected', 'monitor.paused']
const SECRET_PATTERN = /^whsec_(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/
const DOMAIN_PATTERN = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/

export class ApiError extends Error {
  constructor(status, type, message, extra = {}) {
    super(message)
    this.status = status
    this.type = type
    this.extra = extra
  }
}

export function fail(status, type, message, extra) {
  throw new ApiError(status, type, message, extra)
}

function invalid(param, message) {
  fail(400, 'invalid_request', `${param}: ${message}`, { param })
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

// rejects unknown keys, the real API does the same (additionalProperties: false)
export function checkFields(value, allowed, param) {
  if (!isObject(value)) invalid(param || 'body', 'must be an object')
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) invalid(param ? `${param}.${key}` : key, 'unknown field')
  }
  return value
}

export function validString(value, param, min, max) {
  const length = typeof value === 'string' ? [...value].length : -1
  if (length < min || length > max) {
    invalid(param, `must be a string of ${min} to ${max} characters`)
  }
  return value
}

function validUrl(value, param) {
  validString(value, param, 1, 2048)
  let url
  try {
    url = new URL(value)
  } catch {
    invalid(param, 'must be an absolute URL')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') invalid(param, 'must be an http(s) URL')
  if (url.username || url.password) invalid(param, 'must not contain credentials')
  return value
}

function validJudge(value, param) {
  if (value === undefined) return undefined
  checkFields(value, ['threshold'], param)
  const threshold = value.threshold ?? 0.5
  if (typeof threshold !== 'number' || !(threshold > 0 && threshold <= 1)) {
    invalid(`${param}.threshold`, 'must be above 0 and at most 1')
  }
  return { threshold }
}

function validDomains(value, param) {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > 20) invalid(param, 'must be an array of up to 20 host names')

  const domains = []
  value.forEach((entry, i) => {
    const domain = typeof entry === 'string' ? entry.toLowerCase() : ''
    if (domain.length > 253 || !DOMAIN_PATTERN.test(domain)) {
      invalid(`${param}[${i}]`, 'must be a bare host name such as example.com')
    }
    if (!domains.includes(domain)) domains.push(domain)
  })
  return domains
}

function validSearchTarget(target, param) {
  checkFields(target, ['type', 'query', 'max_results', 'filters', 'judge'], param)
  const filters = checkFields(target.filters ?? {}, ['freshness', 'include_domains', 'exclude_domains'], `${param}.filters`)

  const freshness = filters.freshness ?? []
  if (!Array.isArray(freshness) || freshness.some((f) => f !== 'published' && f !== 'updated')) {
    invalid(`${param}.filters.freshness`, 'may contain "published" and "updated"')
  }

  const maxResults = target.max_results ?? 20
  if (!Number.isInteger(maxResults) || maxResults < 1 || maxResults > 20) {
    invalid(`${param}.max_results`, 'must be an integer from 1 to 20')
  }

  const include = validDomains(filters.include_domains, `${param}.filters.include_domains`)
  const exclude = validDomains(filters.exclude_domains, `${param}.filters.exclude_domains`)
  if (include.some((d) => exclude.includes(d))) {
    invalid(`${param}.filters.exclude_domains`, 'a domain may not be in both lists')
  }

  const result = {
    type: 'search',
    query: validString(target.query, `${param}.query`, 1, 1000),
    max_results: maxResults,
    filters: {
      // empty means both
      freshness: freshness.length ? [...new Set(freshness)] : ['published', 'updated'],
      include_domains: include,
      exclude_domains: exclude,
    },
  }
  const judge = validJudge(target.judge, `${param}.judge`)
  if (judge) result.judge = judge
  return result
}

function validPageTarget(target, param) {
  checkFields(target, ['type', 'url', 'judge'], param)
  const result = { type: 'page', url: validUrl(target.url, `${param}.url`) }
  const judge = validJudge(target.judge, `${param}.judge`)
  if (judge) result.judge = judge
  return result
}

// one search target, or 1-10 page targets. Never mixed.
export function validTargets(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 10) {
    invalid('targets', 'must be an array of 1 to 10 targets')
  }
  const targets = value.map((target, i) => {
    const param = `targets[${i}]`
    if (!isObject(target)) invalid(param, 'must be an object')
    if (target.type === 'search') return validSearchTarget(target, param)
    if (target.type === 'page') return validPageTarget(target, param)
    invalid(`${param}.type`, 'must be "search" or "page"')
  })

  const hasSearch = targets.some((t) => t.type === 'search')
  if (hasSearch && targets.length > 1) {
    invalid('targets', 'use exactly one search target, or 1 to 10 page targets')
  }
  const urls = targets.map((t) => t.url)
  if (new Set(urls).size !== urls.length) invalid('targets', 'page URLs must be distinct')
  return targets
}

export function validSchedule(value) {
  if (!isObject(value)) invalid('schedule', 'must be an object')

  if (value.type === 'interval') {
    checkFields(value, ['type', 'interval'], 'schedule')
    try {
      return { type: 'interval', interval: formatInterval(parseInterval(value.interval)) }
    } catch (e) {
      invalid('schedule.interval', e.message)
    }
  }

  if (value.type === 'cron') {
    checkFields(value, ['type', 'cron', 'timezone'], 'schedule')
    const schedule = {
      type: 'cron',
      cron: validString(value.cron, 'schedule.cron', 1, 128).trim(),
      timezone: validString(value.timezone ?? 'UTC', 'schedule.timezone', 1, 64),
    }
    try {
      // two runs in a row: catches both syntax errors and schedules sparser than 31 days
      const first = nextRun(schedule, Date.now())
      nextRun(schedule, first)
    } catch (e) {
      invalid('schedule.cron', e.message)
    }
    return schedule
  }

  invalid('schedule.type', 'must be "interval" or "cron"')
}

// returns { url, events, secret } where secret is undefined unless the caller sent one
export function validWebhook(value) {
  checkFields(value, ['url', 'events', 'secret'], 'webhook')

  const events = value.events ?? []
  if (!Array.isArray(events)) invalid('webhook.events', 'must be an array')
  events.forEach((event, i) => {
    if (!EVENT_TYPES.includes(event)) invalid(`webhook.events[${i}]`, 'unknown event type')
  })

  if (value.secret !== undefined) {
    const s = value.secret
    const ok = typeof s === 'string' && s.length >= 38 && s.length <= 94 && SECRET_PATTERN.test(s)
    if (!ok) invalid('webhook.secret', 'must be whsec_ followed by the base64 of 24 to 64 bytes')
  }

  return {
    url: validUrl(value.url, 'webhook.url'),
    events: events.length ? [...new Set(events)] : DEFAULT_EVENTS,
    secret: value.secret,
  }
}

export function validMetadata(value) {
  if (!isObject(value) || Object.keys(value).length > 16) {
    invalid('metadata', 'must be an object with up to 16 keys')
  }
  for (const [key, val] of Object.entries(value)) {
    const keyLength = [...key].length
    if (keyLength < 1 || keyLength > 64) invalid(`metadata.${key}`, 'keys must be 1 to 64 characters')
    validString(val, `metadata.${key}`, 0, 512)
  }
  return value
}

export function validLimit(raw) {
  const limit = raw ?? '20'
  if (!/^\d+$/.test(limit) || Number(limit) < 1) invalid('limit', 'must be a positive integer')
  return Math.min(Number(limit), 100)
}
