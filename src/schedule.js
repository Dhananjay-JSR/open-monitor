const MINUTES = { m: 1, h: 60, d: 1440, w: 10080 }
const MAX_GAP_MS = 31 * 24 * 60 * 60 * 1000

export function parseInterval(value) {
  const match = typeof value === 'string' && /^([1-9][0-9]*)([mhdw])$/.exec(value)
  const ms = match ? Number(match[1]) * MINUTES[match[2]] * 60000 : 0
  if (!ms || ms > MAX_GAP_MS) {
    throw new Error('interval must be like 30m, 6h, 1d or 2w, from 1m to 31d')
  }
  return ms
}

// largest unit that divides evenly, so 60m comes back as 1h
export function formatInterval(ms) {
  const mins = ms / 60000
  for (const unit of ['w', 'd', 'h']) {
    if (mins % MINUTES[unit] === 0) return mins / MINUTES[unit] + unit
  }
  return mins + 'm'
}

// TODO: month/day names (JAN, MON) and @daily style macros
function parseField(field, min, max) {
  const values = new Set()
  for (const part of field.split(',')) {
    const match = /^(\*|(\d+)(?:-(\d+))?)(?:\/(\d+))?$/.exec(part)
    if (!match) throw new Error(`bad cron field "${field}"`)

    const step = match[4] ? Number(match[4]) : 1
    let from = min
    let to = max
    if (match[1] !== '*') {
      from = Number(match[2])
      if (match[3] !== undefined) to = Number(match[3])
      else if (!match[4]) to = from // "5/10" means from 5 to the end
    }
    if (from < min || to > max || from > to || step === 0) {
      throw new Error(`cron field "${field}" is out of range`)
    }
    for (let v = from; v <= to; v += step) values.add(v)
  }
  return values
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

// next time (ms) after fromMs matching a 5-field cron expression in the given timezone
export function cronNext(expr, timezone, fromMs) {
  const fields = expr.trim().split(/\s+/)
  if (fields.length !== 5) throw new Error('cron must have five fields')

  const minutes = parseField(fields[0], 0, 59)
  const hours = parseField(fields[1], 0, 23)
  const days = parseField(fields[2], 1, 31)
  const months = parseField(fields[3], 1, 12)
  const weekdays = new Set([...parseField(fields[4], 0, 7)].map((d) => d % 7)) // 7 is Sunday too
  const bothDayFields = fields[2] !== '*' && fields[4] !== '*'

  let fmt
  try {
    fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hourCycle: 'h23',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      weekday: 'short',
    })
  } catch {
    throw new Error(`unknown timezone "${timezone}"`)
  }

  let t = Math.floor(fromMs / 60000) * 60000 + 60000
  const end = t + MAX_GAP_MS
  while (t <= end) {
    const parts = {}
    for (const p of fmt.formatToParts(t)) parts[p.type] = p.value
    const minute = Number(parts.minute)

    const dayOfMonth = days.has(Number(parts.day))
    const dayOfWeek = weekdays.has(WEEKDAYS.indexOf(parts.weekday))
    // standard cron: if both day fields are restricted, matching either is enough
    const dayOk = bothDayFields ? dayOfMonth || dayOfWeek : dayOfMonth && dayOfWeek
    const hourOk = months.has(Number(parts.month)) && dayOk && hours.has(Number(parts.hour))

    if (hourOk && minutes.has(minute)) return t
    // wrong hour/day: jump to the next local hour instead of walking every minute
    t += hourOk ? 60000 : (60 - minute) * 60000
  }
  throw new Error('cron must run at least once every 31 days')
}

export function nextRun(schedule, fromMs) {
  if (schedule.type === 'interval') return fromMs + parseInterval(schedule.interval)
  return cronNext(schedule.cron, schedule.timezone, fromMs)
}

const MAX_CRON_JITTER_MS = 10 * 60000

// Random delay added to scheduled starts, like Perplexity: up to 10% of an interval, or up to
// 10 minutes for cron. Spreads out monitors that share a schedule so they don't all start in
// the same second. Cron jitter is also capped at 10% of the gap to the following run, so an
// every-minute cron doesn't get pushed by several minutes.
export function jitterMs(schedule, fromMs, random = Math.random) {
  let max
  if (schedule.type === 'interval') {
    max = parseInterval(schedule.interval) * 0.1
  } else {
    const first = cronNext(schedule.cron, schedule.timezone, fromMs)
    const gap = cronNext(schedule.cron, schedule.timezone, first) - first
    max = Math.min(MAX_CRON_JITTER_MS, gap * 0.1)
  }
  return Math.floor(random() * max)
}

// When a monitor should next run: the next slot from its schedule, plus jitter.
export function scheduleNext(schedule, fromMs, random) {
  return nextRun(schedule, fromMs) + jitterMs(schedule, fromMs, random)
}
