// Dashboard. Plain DOM, no framework, no build step.
// Everything that comes from the API (titles, snippets, diffs) is inserted as text, never as html.

const DAY_MS = 24 * 60 * 60 * 1000
const REPO_URL = 'https://github.com/Dhananjay-JSR/open-monitor'
const SVG_NS = 'http://www.w3.org/2000/svg'
const app = document.getElementById('app')

const state = {
  session: null,
  ready: false, // true once the first screen has been drawn
  monitors: [],
  runs: {}, // monitor id -> runs, newest first
  deliveries: {}, // monitor id -> delivery attempts, newest first
  view: 'all', // 'all' or a monitor id
  sideOpen: false,
  drawer: null, // the new monitor form: { kind, preset, error, typed }
  sheet: false, // phones: the monitor list raised from the bottom bar
  loadError: null,
  setup: null, // first-run setup, see setupScreen()
}
let refreshTimer = null

// Add-ons (like the hosted demo) fill these in. All optional.
//   strip()               text or a node, shown as a thin bar above every screen
//   entry()               a node that replaces the sign-in form
//   lockedSetup()         a monitor id: first-run setup then follows that monitor and only the webhook can be set
//   attachWebhook(url, m) used by "Send test" in a locked setup, resolves to { delivered, status_code, duration_ms, error, secret }
//   signOutLabel          text for the sign-out button
//   api                   shows the API page to non-owners: { keyVar, note, examples({ curl, monitors }) -> [[title, code]], agents(keyVar) -> markdown }
const slots = {}

// ---- small helpers ----

function h(tag, props = {}, ...children) {
  const el = document.createElement(tag)
  for (const [key, value] of Object.entries(props)) {
    if (value === null || value === undefined || value === false) continue
    if (key === 'class') el.className = value
    else if (key === 'text') el.textContent = value
    else if (key.startsWith('on')) el.addEventListener(key.slice(2), value)
    else el.setAttribute(key, value === true ? '' : value)
  }
  // screens are built from nested lists of pieces, so flatten all the way
  for (const child of children.flat(Infinity)) {
    if (child !== null && child !== undefined && child !== false) el.append(child)
  }
  return el
}

function svg(tag, attrs = {}, ...children) {
  const el = document.createElementNS(SVG_NS, tag)
  for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, value)
  el.append(...children)
  return el
}

// line icons (lucide shapes), built as elements so no markup is parsed
const ICONS = {
  search: [['circle', { cx: 11, cy: 11, r: 8 }], ['path', { d: 'm21 21-4.3-4.3' }]],
  file: [['path', { d: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z' }], ['path', { d: 'M14 2v6h6M16 13H8M16 17H8' }]],
  diff: [['path', { d: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z' }], ['path', { d: 'M14 2v6h6M9 10h6M12 7v6M9 17h6' }]],
  inbox: [['path', { d: 'M22 12h-6l-2 3h-4l-2-3H2' }], ['path', { d: 'M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z' }]],
  plus: [['path', { d: 'M5 12h14M12 5v14' }]],
  panel: [['rect', { x: 3, y: 3, width: 18, height: 18, rx: 2 }], ['path', { d: 'M9 3v18' }]],
  list: [['path', { d: 'M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01' }]],
  out: [['path', { d: 'M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9' }]],
  alert: [['path', { d: 'm21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3' }], ['path', { d: 'M12 9v4M12 17h.01' }]],
  x: [['circle', { cx: 12, cy: 12, r: 10 }], ['path', { d: 'm15 9-6 6M9 9l6 6' }]],
  pause: [['circle', { cx: 12, cy: 12, r: 10 }], ['path', { d: 'M10 15V9M14 15V9' }]],
  play: [['path', { d: 'M6 3v18l15-9z' }]],
  check: [['path', { d: 'M20 6 9 17l-5-5' }]],
  close: [['path', { d: 'M18 6 6 18M6 6l12 12' }]],
  eye: [['path', { d: 'M2.06 12.35a1 1 0 0 1 0-.7 10.75 10.75 0 0 1 19.88 0 1 1 0 0 1 0 .7 10.75 10.75 0 0 1-19.88 0' }], ['circle', { cx: 12, cy: 12, r: 3 }]],
  eyeOff: [['path', { d: 'M10.73 5.08A10.43 10.43 0 0 1 12 5c4.53 0 8.36 2.97 9.94 7a10.8 10.8 0 0 1-1.44 2.49M14.08 14.16a3 3 0 0 1-4.24-4.24M17.48 17.5A10.75 10.75 0 0 1 2.06 12a10.8 10.8 0 0 1 4.45-5.5M2 2l20 20' }]],
  code: [['path', { d: 'm16 18 6-6-6-6M8 6l-6 6 6 6' }]],
  github: [['path', { d: 'M15 22v-4a4.8 4.8 0 0 0-1-3.5c3 0 6-2 6-5.5.08-1.25-.27-2.48-1-3.5.28-1.15.28-2.35 0-3.5 0 0-1 0-3 1.5-2.64-.5-5.36-.5-8 0C6 2 5 2 5 2c-.3 1.15-.3 2.35 0 3.5A5.4 5.4 0 0 0 4 9c0 3.5 3 5.5 6 5.5-.39.49-.68 1.05-.85 1.65-.17.6-.22 1.23-.15 1.85v4' }], ['path', { d: 'M9 18c-4.51 2-5-2-7-2' }]],
}

function icon(name) {
  return svg('svg', { class: 'icon', viewBox: '0 0 24 24', 'aria-hidden': 'true' }, ...ICONS[name].map(([tag, attrs]) => svg(tag, attrs)))
}

async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    const error = new Error(data.error?.message ?? `The server answered ${res.status}`)
    error.status = res.status
    error.retryAfter = Number(res.headers.get('retry-after'))
    throw error
  }
  return data
}

// sessionStorage can be missing or throw (private windows, blocked storage); it is only a convenience here
const remember = {
  get(key) {
    try {
      return sessionStorage.getItem(key)
    } catch {
      return null
    }
  },
  set(key, value) {
    try {
      sessionStorage.setItem(key, value)
    } catch {}
  },
}

const isOwner = () => state.session?.role === 'owner'
const canSeeApi = () => isOwner() || Boolean(slots.api)
const clock = (at) => new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })
const shortDate = (ms) => new Date(ms).toLocaleDateString([], { day: 'numeric', month: 'short' })
const startOfDay = (ms) => new Date(new Date(ms).toDateString()).getTime()
const safeUrl = (url) => /^https?:\/\//i.test(url ?? '')
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function hostOf(url) {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

function dayTitle(iso) {
  const day = startOfDay(Date.parse(iso))
  const today = startOfDay(Date.now())
  const date = new Date(day).toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' })
  if (day === today) return ['Today', date]
  if (day === today - DAY_MS) return ['Yesterday', date]
  return [date, '']
}

function inTime(iso) {
  if (!iso) return '—'
  const minutes = Math.round((Date.parse(iso) - Date.now()) / 60000)
  if (minutes <= 0) return 'due now'
  if (minutes < 60) return `in ${minutes} min`
  if (minutes < 48 * 60) return `in ${Math.round(minutes / 60)} h`
  return `in ${Math.round(minutes / 1440)} days`
}

const PRESETS = [['15m', 'Every 15 min'], ['1h', 'Hourly'], ['1d', 'Daily'], ['1w', 'Weekly']]

function scheduleText(schedule) {
  if (schedule.type === 'interval') return PRESETS.find(([id]) => id === schedule.interval)?.[1] ?? 'Every ' + schedule.interval
  return `${schedule.cron} (${schedule.timezone})`
}

// ---- toasts: short notes that rise from the bottom right ----

const toasts = h('div', { class: 'toasts' })
document.body.append(toasts)

function toast(text, { kind = 'info', secret } = {}) {
  const close = () => {
    el.classList.add('out')
    setTimeout(() => el.remove(), 200)
  }
  const copy = (event) =>
    navigator.clipboard
      ?.writeText(secret)
      .then(() => (event.target.textContent = 'Copied'))
      .catch(() => {})
  const el = h(
    'div',
    { class: 'toast' + (kind === 'error' ? ' bad' : ''), role: kind === 'error' ? 'alert' : 'status' },
    icon(kind === 'error' ? 'x' : 'check'),
    h('div', { class: 'toast-body' }, h('div', { text }), secret && h('code', { text: secret })),
    secret && h('button', { class: 'btn ghost', type: 'button', text: 'Copy', onclick: copy }),
    h('button', { class: 'toast-x', type: 'button', 'aria-label': 'Dismiss', onclick: close }, icon('close')),
  )
  toasts.append(el)
  // a signing secret can't be shown again, so that one stays until it is closed
  if (!secret) setTimeout(close, kind === 'error' ? 8000 : 4000)
}

// ---- what the data says ----

const kindOf = (monitor) => monitor.targets[0].type // 'search' or 'page'
const finished = (run) => run.status === 'succeeded' || run.status === 'failed'
const runTime = (run) => run.finished_at ?? run.started_at ?? run.created_at

function watchingText(monitor) {
  if (kindOf(monitor) === 'search') return monitor.targets[0].query
  return monitor.targets.length === 1 ? hostOf(monitor.targets[0].url) : `${monitor.targets.length} pages`
}

// The monitor's newest delivery attempt, if it failed. The delivery log is newest first.
function failingDelivery(monitor) {
  const latest = (state.deliveries[monitor.id] ?? [])[0]
  return latest && !latest.delivered ? latest : null
}

const lastFinishedRun = (monitor) => (state.runs[monitor.id] ?? []).find(finished)

// one status per monitor, for the dot next to it
function statusOf(monitor) {
  if (monitor.status === 'paused') return 'paused'
  if (lastFinishedRun(monitor)?.status === 'failed') return 'failing'
  if (failingDelivery(monitor)) return 'warn'
  return 'ok'
}

// every kept change, newest first
function findings(monitors) {
  const out = []
  for (const monitor of monitors) {
    for (const run of state.runs[monitor.id] ?? []) {
      if (run.status !== 'succeeded') continue
      for (const change of run.changes ?? []) out.push({ monitor, at: runTime(run), change })
    }
  }
  return out.sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
}

const todayCount = (monitors) => findings(monitors).filter((f) => Date.parse(f.at) >= startOfDay(Date.now())).length

// things a person should look at, kept apart from the findings
function problems(monitors) {
  const out = []
  for (const monitor of monitors) {
    const attempt = failingDelivery(monitor)
    if (attempt) {
      const why = attempt.status_code ? `answered ${attempt.status_code}` : attempt.error
      out.push({ kind: 'warn', title: 'Webhook delivery failing', monitor, at: attempt.at, why: `${attempt.target_host ?? 'The webhook'} ${why} on attempt ${attempt.attempt} of 7. Monitoring continues, it pauses only if all 7 fail.` })
    }
    const run = lastFinishedRun(monitor)
    if (run?.status === 'failed') {
      const streak = monitor.fail_streak > 1 ? ` Failed ${monitor.fail_streak} times in a row.` : ''
      out.push({ kind: 'fail', title: 'Run failed', monitor, at: runTime(run), why: (run.error?.message ?? 'The run failed.') + streak })
    }
    if (monitor.status === 'paused' && monitor.pause_reason) {
      out.push({ kind: 'warn', title: 'Paused', monitor, at: monitor.updated_at, why: monitor.pause_reason })
    }
  }
  return out.sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
}

// findings per day for the chart, oldest first, today last
function perDay(monitors, days) {
  const today = startOfDay(Date.now())
  const rows = Array.from({ length: days }, (_, i) => ({ start: today - (days - 1 - i) * DAY_MS, found: 0, runs: 0, failed: 0 }))
  for (const monitor of monitors) {
    for (const run of state.runs[monitor.id] ?? []) {
      if (!finished(run)) continue
      const at = Date.parse(runTime(run))
      const row = rows.find((r) => at >= r.start && at < r.start + DAY_MS)
      if (!row) continue
      row.runs++
      if (run.status === 'failed') row.failed++
      else row.found += run.counts.changes
    }
  }
  return rows
}

// ---- data ----

async function loadAll() {
  try {
    const list = await api('GET', '/v1/monitors?limit=100')
    state.monitors = list.data
    state.loadError = null
    if (!routed) {
      applyHash()
      routed = true
    }
    if (state.view !== 'all' && state.view !== 'api' && !state.monitors.some((m) => m.id === state.view)) state.view = 'all'
    if (!state.setup && setupWanted()) startSetup()
    // the setup only needs the monitors, so draw it now and let runs and deliveries follow
    if (state.setup) render()
    await Promise.all(
      state.monitors.map(async (monitor) => {
        const [runs, attempts] = await Promise.all([
          api('GET', `/v1/monitors/${monitor.id}/runs?limit=50`),
          // the delivery log is owner-only on some setups, so a refusal is not an error here
          api('GET', `/v1/monitors/${monitor.id}/deliveries?limit=50`).catch(() => ({ data: [] })),
        ])
        state.runs[monitor.id] = runs.data
        state.deliveries[monitor.id] = attempts.data
      }),
    )
  } catch (e) {
    if (e.status === 401) state.session = null
    else state.loadError = e.message
  }
  // the setup was already drawn from the monitors alone
  if (!state.setup) render()
  scheduleRefresh()
}

function scheduleRefresh() {
  clearTimeout(refreshTimer)
  if (!state.session) return
  // poll quickly while something is running, lazily otherwise
  const busy = state.monitors.some((m) => m.current_run_id)
  refreshTimer = setTimeout(loadAll, busy ? 2000 : 30000)
}

// runs an action, then reloads. `fn` may return a message to show, otherwise `done` is used.
async function act(fn, done) {
  try {
    const message = (await fn()) ?? done
    if (typeof message === 'string') toast(message)
  } catch (e) {
    toast(e.message, { kind: 'error' })
  }
  await loadAll()
}

// ---- the address bar: #/ or #/monitors/<id>, plus /new or /edit while the drawer is open ----

let routed = false // the hash is read once the monitors are loaded, then kept in step with the screen

function hashFor() {
  const page = state.view === 'all' ? '' : state.view === 'api' ? 'api' : `monitors/${state.view}`
  const open = state.drawer ? (state.drawer.edit ? 'edit' : 'new') : ''
  return '#/' + [page, open].filter(Boolean).join('/')
}

function applyHash() {
  const parts = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean)
  const id = parts[0] === 'monitors' ? parts[1] : null
  const action = id ? parts[2] : parts[0]
  const monitor = state.monitors.find((m) => m.id === id)
  state.view = monitor ? monitor.id : parts[0] === 'api' && canSeeApi() ? 'api' : 'all'
  if (action === 'edit' && monitor && isOwner()) state.drawer = state.drawer?.edit === monitor.id ? state.drawer : drawerFor(monitor)
  else if (action === 'new' && isOwner()) state.drawer = state.drawer && !state.drawer.edit ? state.drawer : drawerFor()
  else state.drawer = null
}

addEventListener('popstate', () => {
  if (!state.session || state.setup) return
  applyHash()
  redraw()
})

function go(view) {
  state.view = view
  state.sheet = false
  render()
  app.querySelector('.main')?.scrollTo(0, 0)
}

// ---- pieces ----

const brand = () => h('span', { class: 'brand-name', text: 'Open Monitor' })

function strip() {
  const content = slots.strip?.()
  return content ? h('div', { class: 'topstrip' }, content) : null
}

// the judge's match score as a 10-tick gauge
function gauge(confidence) {
  const on = Math.round(confidence * 10)
  return h(
    'span',
    { class: 'gauge', title: 'How well it matches the goal' },
    h('span', { class: 'ticks' }, Array.from({ length: 10 }, (_, i) => h('i', { class: i < on ? 'on' : null }))),
    h('span', { class: 'mono', text: confidence.toFixed(2) }),
  )
}

// a unified diff as rows: unchanged lines, what the page said before, what it says now
function diffRows(unified) {
  const rows = []
  for (const line of unified.split('\n')) {
    if (!line || line.startsWith('@@') || line.startsWith('---') || line.startsWith('+++')) continue
    rows.push([line[0] === '+' ? 'after' : line[0] === '-' ? 'before' : 'ctx', line.slice(1)])
  }
  return rows
}

const MAX_DIFF_ROWS = 8

function findingCard({ monitor, at, change }, showMonitor) {
  const page = change.type === 'page_change'
  const head = h(
    'div',
    { class: 'fc-head' },
    h('span', { class: 'type' }, icon(page ? 'diff' : 'search'), page ? 'Page changed' : 'New result'),
    showMonitor && [h('button', { class: 'who', title: 'Open ' + monitor.name, text: monitor.name, onclick: () => go(monitor.id) }), h('span', { text: '·' })],
    h('span', { class: 'mono', text: clock(at) }),
    gauge(change.confidence),
  )
  const titleText = change.title || change.url
  // only http(s) links become clickable, anything else stays plain text
  const title = safeUrl(change.url) ? h('a', { href: change.url, target: '_blank', rel: 'noopener noreferrer', text: titleText }) : titleText

  if (page) {
    const rows = diffRows(change.diff.unified)
    const changed = rows.filter(([kind]) => kind === 'after').length
    const shown = rows.slice(0, MAX_DIFF_ROWS)
    const hidden = rows.length - shown.length
    const row = ([kind, text]) =>
      kind === 'before'
        ? h('div', { class: 'row' }, h('span', { class: 'lbl', text: 'Before' }), h('del', { text }))
        : kind === 'after'
          ? h('div', { class: 'row after' }, h('span', { class: 'lbl', text: 'After' }), h('ins', { text }))
          : h('div', { class: 'row' }, h('span', { class: 'lbl' }), h('span', { class: 'ctx', text }))
    const tail = change.diff.truncated ? 'More changes, the diff was cut at 24 KiB' : hidden > 0 ? `${hidden} more lines` : null
    return h(
      'article',
      { class: 'card' },
      head,
      h('h3', {}, title),
      h(
        'div',
        { class: 'diff2' },
        h('div', { class: 'diff2-head' }, icon('file'), h('span', { class: 'mono', text: change.url.replace(/^https?:\/\//, '') }), h('span', { text: `${changed} line${changed === 1 ? '' : 's'} changed` })),
        shown.map(row),
        tail && row(['ctx', tail]),
      ),
    )
  }

  const host = hostOf(change.url)
  return h(
    'article',
    { class: 'card' },
    head,
    h('div', { class: 'serp-site' }, h('span', { class: 'site', text: host[0]?.toUpperCase() ?? '?' }), host),
    h('h3', {}, title),
    change.snippet && h('p', { text: change.snippet }),
  )
}

function attention(monitors, showMonitor) {
  const list = problems(monitors)
  if (!list.length) return null
  return h(
    'section',
    { class: 'attention' },
    h('h2', { text: 'Needs attention' }),
    list.map((p) =>
      h(
        'div',
        { class: 'att-row' + (p.kind === 'fail' ? ' bad' : ''), title: p.why },
        icon(p.kind === 'fail' ? 'x' : 'alert'),
        h('b', {}, p.title, showMonitor && h('span', { class: 'att-who', text: ' · ' + p.monitor.name })),
        h('span', { class: 'why', text: p.why }),
        h('span', { class: 'mono', text: clock(p.at) }),
      ),
    ),
  )
}

function feed(monitors, showMonitor) {
  const list = findings(monitors)
  if (!list.length) {
    return h('div', { class: 'card empty', text: monitors.length ? 'No findings yet. They show up here when a run keeps something.' : 'No monitors yet.' })
  }
  const out = []
  let day = null
  let group = null
  for (const f of list) {
    const [title, date] = dayTitle(f.at)
    if (title !== day) {
      day = title
      group = h('div', { class: 'feed' })
      out.push(h('div', { class: 'day' }, title, date && h('span', { text: date })), group)
    }
    group.append(findingCard(f, showMonitor))
  }
  return out
}

// a small tooltip for the charts, filled with text only
function tip(target, lines) {
  const box = target.closest('.chart')
  const el = box.querySelector('.tip')
  if (!lines) {
    el.style.display = 'none'
    return
  }
  el.replaceChildren(...lines.map((line, i) => (i ? h('div', { text: line }) : h('b', { text: line }))))
  const a = target.getBoundingClientRect()
  const b = box.getBoundingClientRect()
  el.style.display = 'block'
  el.style.left = `${Math.min(Math.max(a.left - b.left + a.width / 2, 64), b.width - 64)}px`
  el.style.top = `${a.top - b.top}px`
}

function hoverTip(el, lines) {
  el.addEventListener('mouseenter', () => tip(el, lines))
  el.addEventListener('mouseleave', () => tip(el))
  el.addEventListener('focus', () => tip(el, lines))
  el.addEventListener('blur', () => tip(el))
  return el
}

function svgText(attrs, text) {
  const el = svg('text', attrs)
  el.textContent = text
  return el
}

function findingsChart(monitors) {
  // phones get two weeks, so bars and labels stay readable
  const narrow = matchMedia('(max-width: 820px)').matches
  const days = perDay(monitors, narrow ? 14 : 30)
  const W = narrow ? 340 : 760
  const H = 180
  const top = 24
  const base = 148
  const max = Math.max(1, ...days.map((d) => d.found))
  const step = W / days.length
  const bw = Math.min(16, step - 6)
  const x = (i) => i * step + step / 2
  const y = (v) => base - (v / max) * (base - top)
  const total = days.reduce((a, d) => a + d.found, 0)
  const last = days.length - 1
  const peak = days.findIndex((d) => d.found === max)

  const plot = svg('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': `Findings per day over the last ${days.length} days, ${total} in total, ${days[last].found} today` })
  plot.append(svg('line', { class: 'grid base', x1: 0, x2: W, y1: base, y2: base }))
  days.forEach((d, i) => {
    const today = i === last
    const cx = x(i)
    const lines = [today ? 'Today' : shortDate(d.start), `${d.found} finding${d.found === 1 ? '' : 's'} from ${d.runs} run${d.runs === 1 ? '' : 's'}`]
    if (d.failed) lines.push(`${d.failed} failed`)
    plot.append(hoverTip(svg('rect', { class: 'hit', x: i * step, y: 0, width: step, height: H, fill: 'transparent' }), lines))
    if (!d.found) return
    const hgt = base - y(d.found)
    const r = Math.min(4, hgt)
    const bx = cx - bw / 2
    plot.append(svg('path', { class: 'bar' + (today ? ' today' : ''), d: `M${bx},${base} v${-(hgt - r)} q0,${-r} ${r},${-r} h${bw - 2 * r} q${r},0 ${r},${r} v${hgt - r} z` }))
    if (today || i === peak) plot.append(svgText({ class: 'val' + (today ? ' now' : ''), x: cx, y: y(d.found) - 8, 'text-anchor': 'middle' }, d.found))
  })
  const mid = Math.floor(last / 2)
  for (const [i, anchor] of [[0, 'start'], [mid, 'middle'], [last, 'end']]) {
    const ax = anchor === 'start' ? x(i) - bw / 2 : anchor === 'end' ? x(i) + bw / 2 : x(i)
    plot.append(svgText({ class: 'axis', x: ax, y: H - 4, 'text-anchor': anchor }, i === last ? 'Today' : shortDate(days[i].start)))
  }
  return h(
    'section',
    { class: 'chart' },
    h('div', { class: 'chart-head' }, h('h2', { text: 'Findings per day' }), h('span', {}, h('b', { class: 'today-count', text: `${days[last].found} today` }), ` · ${total} in the last ${days.length} days`)),
    plot,
    h('div', { class: 'tip' }),
  )
}

function runStrip(monitor) {
  const all = state.runs[monitor.id] ?? []
  const runs = all.filter(finished).slice(0, 30).reverse()
  // a page monitor's very first run only saves the page to compare against later.
  // The list holds the newest 50 runs, so with fewer than that its oldest run is the first one.
  const firstRun = kindOf(monitor) === 'page' && all.length < 50 ? all.at(-1) : null
  const kindOfRun = (run) => (run.status === 'failed' ? 'fail' : run.counts.changes ? 'found' : run === firstRun ? 'base' : 'none')
  const label = { found: 'Found something', none: 'Nothing new', base: 'Baseline saved', fail: 'Failed' }
  const found = runs.filter((r) => kindOfRun(r) === 'found').length
  const failed = runs.filter((r) => kindOfRun(r) === 'fail').length
  return h(
    'section',
    { class: 'chart' },
    h(
      'div',
      { class: 'chart-head' },
      h('h2', { text: runs.length > 1 ? `Last ${runs.length} runs` : runs.length ? 'Last run' : 'Runs' }),
      h('span', { text: runs.length ? `${found} found something, ${failed} failed` : 'No runs yet' }),
      h('div', { class: 'legend' }, h('span', {}, h('i', { class: 'lg-found' }), 'Found'), h('span', {}, h('i', { class: 'lg-none' }), 'Nothing new'), h('span', {}, h('i', { class: 'lg-fail' }), 'Failed')),
    ),
    h(
      'div',
      { class: 'strip' },
      runs.map((run) => {
        const kind = kindOfRun(run)
        const when = new Date(runTime(run)).toLocaleString([], { hour12: false, day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
        const lines = [when, label[kind] + (run.counts.changes ? `, ${run.counts.changes} kept` : '')]
        return hoverTip(h('button', { 'data-k': kind, 'aria-label': lines.join(': ') }), lines)
      }),
    ),
    runs.length > 1 && h('div', { class: 'strip-axis' }, h('span', { text: 'Older' }), h('span', { text: 'Latest' })),
    h('div', { class: 'tip' }),
  )
}

// ---- screens: dashboard ----

const monitorIcon = (m) => h('span', { class: 'kind' }, icon(kindOf(m) === 'search' ? 'search' : 'file'), h('span', { class: 'dot', 'data-s': statusOf(m) }))

function navItem(id, label, lead, count) {
  return h(
    'button',
    { class: 'nav' + (count ? ' has-new' : ''), 'aria-current': String(state.view === id), title: label, onclick: () => go(id) },
    h('span', { class: 'slot' }, lead),
    h('span', { class: 'grow', text: label }),
    count ? h('span', { class: 'n', text: count }) : null,
  )
}

function sidebar() {
  const toggle = h(
    'button',
    {
      class: 'icon-btn side-toggle',
      'aria-label': state.sideOpen ? 'Collapse sidebar' : 'Expand sidebar',
      'aria-expanded': String(state.sideOpen),
      title: state.sideOpen ? 'Collapse' : 'Expand',
      // flip the class on the existing layout instead of redrawing it, so the width can animate
      onclick: (event) => {
        state.sideOpen = !state.sideOpen
        app.querySelector('.app').classList.toggle('collapsed', !state.sideOpen)
        const button = event.currentTarget
        button.setAttribute('aria-expanded', String(state.sideOpen))
        button.setAttribute('aria-label', state.sideOpen ? 'Collapse sidebar' : 'Expand sidebar')
        button.title = state.sideOpen ? 'Collapse' : 'Expand'
      },
    },
    icon('panel'),
  )
  return h(
    'aside',
    { class: 'side' },
    h('div', { class: 'brand' }, brand(), toggle),
    h('div', { class: 'nav-list' }, navItem('all', 'All findings', icon('inbox'), todayCount(state.monitors))),
    h('div', { class: 'side-label', text: 'Monitors' }),
    h(
      'div',
      { class: 'nav-list' },
      state.monitors.map((m) => navItem(m.id, m.name, monitorIcon(m), todayCount([m]))),
      isOwner() && h('button', { class: 'nav new-btn', title: 'New monitor', onclick: openDrawer }, h('span', { class: 'slot' }, icon('plus')), h('span', { class: 'grow', text: 'New monitor' })),
    ),
    h(
      'div',
      { class: 'nav-list side-bottom' },
      canSeeApi() && h('button', { class: 'nav api-nav', 'aria-current': String(state.view === 'api'), title: 'API', onclick: () => go('api') }, h('span', { class: 'slot' }, icon('code')), h('span', { class: 'grow', text: 'API' })),
      h('a', { class: 'nav repo-nav', href: REPO_URL, target: '_blank', rel: 'noopener noreferrer', title: 'GitHub' }, h('span', { class: 'slot' }, icon('github')), h('span', { class: 'grow', text: 'GitHub' })),
    ),
    // the footer mirrors the header: who is signed in, and the sign-out button where the toggle sits
    h(
      'div',
      { class: 'side-foot' },
      h('span', { class: 'slot' }, h('span', { class: 'avatar', text: (state.session.username || '?')[0].toUpperCase() })),
      h('span', { class: 'user', text: state.session.username }),
      h('button', { class: 'icon-btn', title: slots.signOutLabel ?? 'Sign out', 'aria-label': slots.signOutLabel ?? 'Sign out', onclick: signOut }, icon('out')),
    ),
  )
}

// phones: a bottom bar instead of the sidebar, and the monitor list as a sheet
function bottomBar() {
  const onMonitor = state.view !== 'all'
  const item = (label, ic, current, onclick, badge) => h('button', { 'aria-current': String(current), onclick }, icon(ic), label, badge ? h('span', { class: 'badge', text: badge }) : null)
  const closeSheet = () => ((state.sheet = false), render())
  return [
    h(
      'nav',
      { class: 'bnav', 'aria-label': 'Main' },
      item('Findings', 'inbox', !onMonitor, () => go('all'), todayCount(state.monitors)),
      item('Monitors', 'list', onMonitor, () => ((state.sheet = true), render())),
      isOwner() && item('New', 'plus', false, openDrawer),
      item(slots.signOutLabel ?? 'Sign out', 'out', false, signOut),
    ),
    h('div', { class: 'sheet-scrim' + (state.sheet ? ' open' : ''), onclick: closeSheet }),
    h('section', { class: 'sheet' + (state.sheet ? ' open' : ''), 'aria-label': 'Monitors' }, h('div', { class: 'grip' }), h('h2', { text: 'Monitors' }), h('div', { class: 'nav-list' }, state.monitors.map((m) => navItem(m.id, m.name, monitorIcon(m), todayCount([m]))), canSeeApi() && navItem('api', 'API', icon('code')))),
  ]
}

function banners() {
  const out = []
  if (state.session.judge_configured === false) {
    out.push(
      h(
        'div',
        { class: 'notice bad', role: 'status' },
        icon('alert'),
        h('div', {}, h('b', { text: 'No LLM is configured' }), h('div', { class: 'why' }, 'Every run fails until the server has ', h('code', { text: 'LLM_API_KEY' }), ', ', h('code', { text: 'LLM_BASE_URL' }), ' or ', h('code', { text: 'LLM_COMMAND' }), '.')),
      ),
    )
  }
  if (state.loadError) out.push(h('div', { class: 'notice bad', role: 'alert' }, icon('x'), h('div', {}, h('b', { text: 'Could not load' }), h('div', { class: 'why', text: state.loadError }))))
  return out
}

function overviewPage() {
  return [banners(), findingsChart(state.monitors), attention(state.monitors, true), feed(state.monitors, true)]
}

function monitorPage(monitor) {
  const path = `/v1/monitors/${monitor.id}`
  const running = Boolean(monitor.current_run_id)
  const call = (suffix) => () => act(() => api('POST', path + suffix).then(() => undefined))
  const actions = []
  if (monitor.status === 'active' && state.session.can_run !== false) {
    actions.push(h('button', { class: 'btn primary', disabled: running, 'aria-busy': running ? 'true' : null, onclick: call('/run') }, icon('play'), running ? 'Running' : 'Run now'))
  }
  if (isOwner()) {
    const testWebhook = () =>
      act(async () => {
        const result = await api('POST', path + '/webhook/test')
        if (!result.delivered) throw new Error(`Webhook test failed: ${result.status_code ? 'answered ' + result.status_code : result.error}`)
        return `Webhook answered ${result.status_code} in ${result.duration_ms} ms`
      })
    actions.push(
      monitor.status === 'active' ? h('button', { class: 'btn', text: 'Pause', onclick: call('/pause') }) : h('button', { class: 'btn', text: 'Resume', onclick: call('/resume') }),
      h('button', { class: 'btn ghost', text: 'Edit', onclick: () => openDrawer(monitor) }),
      h('button', { class: 'btn ghost', text: 'Copy as curl', onclick: () => copyText(createCurl(monitor), 'Copied the curl command that creates this monitor') }),
      monitor.webhook && h('button', { class: 'btn ghost', text: 'Test webhook', onclick: testWebhook }),
      h('span', { class: 'spacer' }),
      h('button', {
        class: 'btn ghost danger',
        text: 'Delete',
        onclick: () => {
          if (!confirm(`Delete "${monitor.name}" and its run history?`)) return
          state.view = 'all'
          act(() => api('DELETE', path).then(() => undefined), 'Monitor deleted')
        },
      }),
    )
  }
  const nextRun = running ? 'running now' : monitor.status === 'paused' ? '—' : inTime(monitor.next_run_at)
  return [
    banners(),
    h(
      'div',
      { class: 'mhead' },
      h('h2', { text: monitor.name }),
      monitor.goal && h('p', { class: 'goal', text: monitor.goal }),
      h(
        'dl',
        { class: 'facts' },
        h('div', {}, h('dt', { text: kindOf(monitor) === 'search' ? 'Query' : 'Watching' }), h('dd', { text: watchingText(monitor) })),
        h('div', {}, h('dt', { text: 'Schedule' }), h('dd', { text: scheduleText(monitor.schedule) })),
        h('div', {}, h('dt', { text: 'Next run' }), h('dd', { class: 'mono', text: nextRun })),
        isOwner() && h('div', {}, h('dt', { text: 'Webhook' }), h('dd', { text: monitor.webhook ? hostOf(monitor.webhook.url) : 'None' })),
      ),
      monitor.status === 'paused' && !monitor.pause_reason && h('div', { class: 'notice paused' }, icon('pause'), h('div', {}, h('b', { text: 'Paused' }), h('div', { class: 'why', text: 'Not running on its schedule. Resume to pick up where it left off, nothing since the pause is missed.' }))),
      actions.length > 0 && h('div', { class: 'actions' }, actions),
    ),
    runStrip(monitor),
    attention([monitor], false),
    feed([monitor], false),
  ]
}

// ---- API page: the same things over HTTP, for scripts and agents ----

const KEY_VAR = '$OPEN_MONITOR_API_KEY'

function copyText(text, done = 'Copied') {
  navigator.clipboard
    ?.writeText(text)
    .then(() => toast(done))
    .catch(() => toast('Copying is blocked here. Select the text and copy it instead', { kind: 'error' }))
}

function curl(method, path, body, keyVar = KEY_VAR) {
  const lines = [`curl${method === 'GET' ? '' : ' -X ' + method} "${location.origin}${path}"`, `  -H "Authorization: Bearer ${keyVar}"`]
  if (body) lines.push('  -H "Content-Type: application/json"', `  -d '${JSON.stringify(body, null, 2).replace(/'/g, "'\\''").replace(/\n/g, '\n  ')}'`)
  return lines.join(' \\\n')
}

// the request that would create this monitor again, e.g. on another server
function createCurl(monitor) {
  const body = { name: monitor.name, goal: monitor.goal, targets: monitor.targets, schedule: monitor.schedule }
  if (monitor.webhook) body.webhook = { url: monitor.webhook.url, events: monitor.webhook.events }
  return curl('POST', '/v1/monitors', body)
}

function agentsMarkdown(keyVar = KEY_VAR) {
  const base = location.origin
  return `## Open Monitor

Open Monitor watches web searches and pages on a schedule and reports findings that match a goal.

- Base URL: ${base}
- Auth: send \`Authorization: Bearer ${keyVar}\` with every /v1 request.
- API description, OpenAPI 3.1, no key needed: ${base}/openapi.json

Common tasks:

- Create a monitor: \`POST /v1/monitors\` with \`name\`, \`targets\` (one \`{"type": "search", "query": "..."}\` or up to 10 \`{"type": "page", "url": "..."}\`), \`goal\`, \`schedule\` (\`{"type": "interval", "interval": "1d"}\`) and optionally \`webhook: {"url": "..."}\`. The response includes \`webhook.secret\` once, store it.
- Read findings: \`GET /v1/monitors/{id}/runs\`. Each run's \`changes\` are the kept findings.
- Run now: \`POST /v1/monitors/{id}/run\`, then poll \`GET /v1/monitors/{id}/runs/{run_id}\` until \`status\` is \`succeeded\` or \`failed\`.
- Change or remove the webhook: \`PATCH /v1/monitors/{id}\` with \`{"webhook": {"url": "..."}}\` or \`{"webhook": null}\`.

Webhook deliveries follow Standard Webhooks. Before trusting one, check \`webhook-signature\`: it is \`v1,\` plus the base64 HMAC-SHA256 of \`{webhook-id}.{webhook-timestamp}.{raw body}\`, keyed with the base64-decoded part of the secret after \`whsec_\`. Event types: monitor.changes.detected, monitor.run.completed, monitor.paused.
`
}

const VERIFY_SNIPPET = `import { createHmac, timingSafeEqual } from 'node:crypto'

// headers of the delivery, the raw body as a string, and the monitor's whsec_ secret
export function verify(headers, body, secret) {
  const key = Buffer.from(secret.slice('whsec_'.length), 'base64')
  const signed = \`\${headers['webhook-id']}.\${headers['webhook-timestamp']}.\${body}\`
  const expected = Buffer.from(createHmac('sha256', key).update(signed).digest('base64'))
  // during a secret rotation two signatures arrive, separated by a space
  return headers['webhook-signature'].split(' ').some((entry) => {
    const given = Buffer.from(entry.split(',')[1] ?? '')
    return given.length === expected.length && timingSafeEqual(given, expected)
  })
}`

function codeCard(title, code) {
  return h(
    'section',
    { class: 'code-card' },
    h('div', { class: 'code-head' }, h('h3', { text: title }), h('button', { class: 'btn ghost', type: 'button', text: 'Copy', onclick: () => copyText(code) })),
    h('pre', { class: 'code', tabindex: 0 }, h('code', { text: code })),
  )
}

function apiPage() {
  // owners use the server's API_KEY; an add-on can describe its own key and examples for everyone else
  const custom = isOwner() ? null : slots.api
  const keyVar = custom?.keyVar ?? KEY_VAR
  const first = state.monitors[0]
  const exampleId = first?.id ?? 'MONITOR_ID'
  const example = {
    name: 'Open Monitor releases',
    goal: 'A new release, or a breaking change in one',
    targets: [{ type: 'page', url: REPO_URL + '/releases' }],
    schedule: { type: 'interval', interval: '1d' },
    webhook: { url: 'https://webhook.site/your-id' },
  }
  return [
    h(
      'div',
      { class: 'mhead' },
      h('h2', { text: 'API' }),
      h('p', { class: 'goal', text: 'Everything on this dashboard works over HTTP too, for scripts and AI agents.' }),
      h(
        'dl',
        { class: 'facts' },
        h('div', {}, h('dt', { text: 'Base URL' }), h('dd', { class: 'mono', text: location.origin })),
        h('div', {}, h('dt', { text: 'Auth' }), h('dd', { class: 'mono', text: `Bearer ${keyVar}` })),
        h('div', {}, h('dt', { text: 'Spec' }), h('dd', {}, h('a', { class: 'link', href: '/openapi.json', target: '_blank', rel: 'noopener noreferrer', text: '/openapi.json' }))),
      ),
      h('p', { class: 'api-note', text: custom?.note ?? `${KEY_VAR} stands for the API_KEY in your server's .env. It is never sent to this page.` }),
      h('div', { class: 'actions' }, h('button', { class: 'btn primary', text: 'Copy for AGENTS.md', onclick: () => copyText(custom?.agents?.(keyVar) ?? agentsMarkdown(keyVar), 'Copied. Paste it into your AGENTS.md') }), h('a', { class: 'btn ghost', href: '/openapi.json', target: '_blank', rel: 'noopener noreferrer', text: 'Open the spec' })),
    ),
    h(
      'div',
      { class: 'feed' },
      custom?.examples
        ? custom.examples({ curl: (method, path, body) => curl(method, path, body, keyVar), monitors: state.monitors }).map(([title, code]) => codeCard(title, code))
        : [
            codeCard('Create a monitor', curl('POST', '/v1/monitors', example)),
            codeCard('Read findings', curl('GET', `/v1/monitors/${exampleId}/runs?limit=5`)),
            codeCard('Run now', curl('POST', `/v1/monitors/${exampleId}/run`)),
          ],
      codeCard('Verify a webhook delivery (Node)', VERIFY_SNIPPET),
    ),
  ]
}

function dashboard() {
  const monitor = state.monitors.find((m) => m.id === state.view)
  return h(
    'div',
    { class: 'app' + (state.sideOpen ? '' : ' collapsed') },
    sidebar(),
    h('main', { class: 'main' }, h('div', { class: 'top' }, h('h1', { text: monitor ? monitor.name : state.view === 'api' ? 'API' : 'All findings' })), h('div', { class: 'page' }, monitor ? monitorPage(monitor) : state.view === 'api' ? apiPage() : overviewPage())),
    bottomBar(),
    drawer(),
  )
}

async function signOut() {
  await api('POST', '/auth/logout').catch(() => {})
  state.session = null
  state.setup = null
  boot()
}

// ---- new monitor and edit monitor drawer ----

// with a monitor the drawer edits it, otherwise it creates a new one
function openDrawer(monitor) {
  state.drawer = drawerFor(monitor)
  state.sheet = false
  render()
  setTimeout(() => document.getElementById('d-what')?.focus(), 50)
}

function drawerFor(monitor) {
  if (monitor?.id) {
    const { schedule } = monitor
    return {
      edit: monitor.id,
      kind: kindOf(monitor),
      preset: schedule.type === 'cron' ? 'cron' : schedule.interval,
      hadWebhook: Boolean(monitor.webhook),
      error: null,
      typed: {
        what: monitor.targets.map((t) => t.query ?? t.url).join('\n'),
        goal: monitor.goal,
        name: monitor.name,
        hook: monitor.webhook?.url ?? '',
        cron: schedule.type === 'cron' ? schedule.cron : '',
      },
    }
  }
  return { kind: 'search', preset: '1d', error: null, typed: {} }
}

function closeDrawer() {
  state.drawer = null
  render()
}

function webhookHint() {
  return h('small', {}, 'No webhook? Try ', h('a', { class: 'link', href: 'https://webhook.site', target: '_blank', rel: 'noopener noreferrer', text: 'webhook.site' }))
}

function drawer() {
  const d = state.drawer
  const scrim = h('div', { class: 'scrim' + (d ? ' open' : ''), onclick: closeDrawer })
  const panel = h('aside', { class: 'drawer' + (d ? ' open' : ''), 'aria-label': 'New monitor', 'aria-hidden': d ? null : 'true' })
  if (!d) return [scrim, panel]

  const what = d.kind === 'search' ? h('input', { class: 'input', id: 'd-what', required: true, placeholder: 'AI infrastructure startup raises funding', autocomplete: 'off' }) : h('textarea', { class: 'input', id: 'd-what', required: true, placeholder: 'https://example.com/changelog' })
  const goal = h('textarea', { class: 'input', id: 'd-goal', maxlength: 2000, placeholder: 'New funding rounds for GPU cloud companies' })
  const name = h('input', { class: 'input', id: 'd-name', required: true, maxlength: 256, placeholder: 'AI infrastructure funding', autocomplete: 'off' })
  const hook = h('input', { class: 'input', id: 'd-hook', type: 'url', inputmode: 'url', placeholder: 'https://', autocomplete: 'off' })
  const cron = h('input', { class: 'input mono', id: 'd-cron', required: d.preset === 'cron', placeholder: '0 9 * * 1-5', autocomplete: 'off' })
  // switching the kind or the schedule redraws the form, so carry over what was typed
  const fields = { what, goal, name, hook, cron }
  for (const [key, el] of Object.entries(fields)) el.value = d.typed[key] ?? ''
  const typed = () => Object.fromEntries(Object.entries(fields).map(([key, el]) => [key, el.value]))
  const redrawWith = (change) => () => ((state.drawer = { ...d, ...change, typed: typed() }), render())

  async function submit(event) {
    event.preventDefault()
    const text = what.value.trim()
    const body = {
      name: name.value.trim(),
      goal: goal.value.trim(),
      targets: d.kind === 'search' ? [{ type: 'search', query: text }] : text.split(/\s+/).filter(Boolean).map((url) => ({ type: 'page', url })),
      schedule: d.preset === 'cron' ? { type: 'cron', cron: cron.value.trim() } : { type: 'interval', interval: d.preset },
    }
    const url = hook.value.trim()
    if (url) body.webhook = { url }
    // an emptied webhook field on an existing monitor removes its webhook
    else if (d.edit && d.hadWebhook) body.webhook = null
    try {
      const saved = d.edit ? await api('PATCH', `/v1/monitors/${d.edit}`, body) : await api('POST', '/v1/monitors', body)
      state.drawer = null
      state.view = saved.id
      if (saved.webhook?.secret) toast('Webhook signing secret. It is shown only this once', { secret: saved.webhook.secret })
      else if (d.edit) toast('Saved')
      await loadAll()
    } catch (e) {
      state.drawer = { ...d, typed: typed(), error: e.message }
      render()
    }
  }

  // a monitor watches either a search or pages; that is fixed once it exists
  const seg = (kind, title, sub) => h('button', { type: 'button', 'aria-pressed': String(d.kind === kind), disabled: Boolean(d.edit) && d.kind !== kind, onclick: d.edit ? null : redrawWith({ kind }) }, h('b', { text: title }), h('span', { text: sub }))
  const preset = (id, label) => h('button', { type: 'button', 'aria-pressed': String(d.preset === id), onclick: redrawWith({ preset: id }) }, label)
  // an existing monitor may run on an interval the presets don't list, like 6h
  const presets = PRESETS.some(([id]) => id === d.preset) || d.preset === 'cron' ? PRESETS : [...PRESETS, [d.preset, 'Every ' + d.preset]]
  const removeHook = d.edit && hook.value && h('button', { class: 'btn ghost danger', type: 'button', text: 'Remove', onclick: () => ((hook.value = ''), (state.drawer = { ...d, typed: typed() }), render()) })

  panel.setAttribute('aria-label', d.edit ? 'Edit monitor' : 'New monitor')
  panel.append(
    h(
      'form',
      { onsubmit: submit },
      h('h2', { text: d.edit ? 'Edit monitor' : 'New monitor' }),
      h('div', { class: 'seg' }, seg('search', 'Web search', 'New results for a query'), seg('page', 'Pages', 'Changes on a page')),
      h('div', { class: 'field' }, h('label', { for: 'd-what', text: d.kind === 'search' ? 'Search query' : 'Page URLs, one per line' }), what),
      h('div', { class: 'field' }, h('label', { for: 'd-goal', text: 'What counts as a finding' }), goal),
      h('div', { class: 'field' }, h('label', { text: 'How often' }), h('div', { class: 'presets' }, presets.map(([id, label]) => preset(id, label)), preset('cron', 'Cron')), d.preset === 'cron' && cron),
      h('div', { class: 'field' }, h('label', { for: 'd-name', text: 'Name' }), name),
      h('div', { class: 'field' }, h('label', { for: 'd-hook' }, 'Webhook URL ', h('span', { text: 'optional' })), removeHook ? h('div', { class: 'hook-row' }, hook, removeHook) : hook, webhookHint()),
      d.error && h('p', { class: 'form-error', role: 'alert', text: d.error }),
      h('div', { class: 'actions drawer-actions' }, h('button', { class: 'btn primary', text: d.edit ? 'Save' : 'Create monitor' }), h('button', { class: 'btn ghost', type: 'button', text: 'Cancel', onclick: closeDrawer })),
    ),
  )
  return [scrim, panel]
}

// ---- screens: sign in ----

// pictures for the sign-in page; examples of what a finding looks like, not anyone's data
const at = (hour, minute) => new Date().setHours(hour, minute, 0, 0)
const SAMPLES = [
  { monitor: { id: '', name: 'AI infrastructure funding' }, at: at(9, 3), change: { type: 'search_result', title: 'Lambda raises $1.5B to expand its GPU cloud', url: 'https://techcrunch.com', confidence: 0.97, snippet: 'The round, led by existing investors, values the company at $12B and funds four new data centres in the US and Europe.' } },
  { monitor: { id: '', name: 'AI infrastructure funding' }, at: at(9, 3), change: { type: 'search_result', title: 'Etched closes $420M Series B for its transformer ASIC', url: 'https://bloomberg.com', confidence: 0.88, snippet: 'The chip startup says the funding will take its inference accelerator into volume production next year.' } },
  { monitor: { id: '', name: 'Open-weight model releases' }, at: at(8, 1), change: { type: 'search_result', title: 'A new open-weight model ships with a model card', url: 'https://huggingface.co', confidence: 0.91, snippet: 'The mixture-of-experts model comes with weights, a model card and a 256K context window.' } },
]

function signInForm() {
  const username = h('input', { class: 'input', id: 'login-user', autocomplete: 'username', required: true })
  const password = h('input', { class: 'input', id: 'login-pass', type: 'password', autocomplete: 'current-password', required: true })
  const error = h('span', { class: 'form-error', id: 'login-error', role: 'alert' })
  const button = h('button', { class: 'btn primary', text: 'Sign in' })
  // show the password as text while checking what was typed
  const reveal = h('button', {
    class: 'pw-reveal',
    type: 'button',
    'aria-label': 'Show password',
    title: 'Show password',
    onclick: () => {
      const showing = password.type === 'text'
      password.type = showing ? 'password' : 'text'
      reveal.replaceChildren(icon(showing ? 'eye' : 'eyeOff'))
      reveal.setAttribute('aria-label', showing ? 'Show password' : 'Hide password')
      reveal.title = showing ? 'Show password' : 'Hide password'
      password.focus()
    },
  }, icon('eye'))

  async function submit(event) {
    event.preventDefault()
    error.textContent = ''
    password.removeAttribute('aria-invalid')
    button.setAttribute('aria-busy', 'true')
    try {
      const result = await api('POST', '/auth/login', { username: username.value, password: password.value })
      // add-ons can keep something from the login response, like the demo's visitor token
      slots.onLogin?.(result)
      await boot()
    } catch (e) {
      button.removeAttribute('aria-busy')
      password.setAttribute('aria-invalid', 'true')
      if (e.status === 429) {
        const minutes = Math.max(1, Math.ceil(e.retryAfter / 60))
        error.textContent = `Too many wrong tries. This login is locked for about ${minutes} more minutes.`
      } else {
        error.textContent = e.message
      }
    }
  }

  return h(
    'form',
    { class: 'auth-body', onsubmit: submit },
    h('div', { class: 'field' }, h('label', { for: 'login-user', text: 'Username' }), username),
    h('div', { class: 'field' }, h('label', { for: 'login-pass', text: 'Password' }), h('div', { class: 'pw-wrap' }, password, reveal), error),
    button,
    h('div', { id: 'login-extra' }), // add-ons can put something here
  )
}

function signInScreen() {
  return [
    strip(),
    h(
      'div',
      { class: 'auth' },
      h(
        'div',
        { class: 'auth-form' },
        h('div', { class: 'brand' }, brand()),
        h('div', { class: 'auth-center' }, h('a', { class: 'repo-link', href: REPO_URL, target: '_blank', rel: 'noopener noreferrer', title: 'GitHub', 'aria-label': 'Open Monitor on GitHub' }, icon('github')), slots.entry?.() ?? signInForm()),
      ),
      h(
        'div',
        { class: 'auth-side', 'aria-hidden': 'true', inert: true },
        h('div', { class: 'deck' }, h('div', { class: 'auth-caption' }, h('b', { text: 'This morning' }), ' · 3 findings from 41 results judged'), h('div', { class: 'deck-cards' }, SAMPLES.map((s) => findingCard(s, true)))),
      ),
    ),
  ]
}

// ---- screens: first-run setup ----

const TEMPLATES = [
  { id: 'funding', name: 'Funding news', blurb: 'New rounds in a market you follow', kind: 'search', what: 'AI infrastructure startup raises funding', goal: 'New funding rounds for companies building GPU cloud, AI chips or inference infrastructure', preset: '1d' },
  { id: 'changelog', name: 'A changelog', blurb: 'New releases on a page you depend on', kind: 'page', what: REPO_URL + '/releases', goal: 'A new release, or a breaking change in one', preset: '1d' },
  { id: 'models', name: 'Model releases', blurb: 'Open-weight models as they ship', kind: 'search', what: 'open weight LLM released model card', goal: 'A new open-weight language model with a model card or download link', preset: '1d' },
  { id: 'custom', name: 'Something else', blurb: 'Start from an empty monitor', kind: 'search', what: '', goal: '', preset: '1d' },
]

// Owners see setup while they have no monitors. With an add-on's lockedSetup(), it shows once per browser session.
function setupWanted() {
  if (!state.session || remember.get('om_setup_done')) return false
  if (slots.lockedSetup) return Boolean(slots.lockedSetup())
  return isOwner() && state.monitors.length === 0
}

function startSetup() {
  const lockedId = slots.lockedSetup?.()
  const locked = lockedId ? state.monitors.find((m) => m.id === lockedId) : null
  if (lockedId && !locked) return
  const base = { step: 1, hook: '', test: null, shown: 0, log: [], done: false, failed: false }
  if (locked) {
    const what = locked.targets.map((t) => t.query ?? t.url).join('\n')
    // show the same goal and schedule as the template the monitor was built from
    const tpl = TEMPLATES.find((t) => t.kind === kindOf(locked) && (t.what === what || t.goal === locked.goal))
    state.setup = { ...base, locked, kind: kindOf(locked), what, goal: tpl?.goal ?? locked.goal, preset: locked.schedule.interval ?? tpl?.preset ?? null }
  } else {
    const t = TEMPLATES[0]
    state.setup = { ...base, tpl: t.id, kind: t.kind, what: t.what, goal: t.goal, preset: t.preset }
  }
}

function finishSetup(view) {
  remember.set('om_setup_done', '1')
  state.setup = null
  if (view) state.view = view
  loadAll()
}

// what was typed into the current step, read before the screen is redrawn
function readSetupFields() {
  const s = state.setup
  for (const [id, key] of [['s-what', 'what'], ['s-goal', 'goal'], ['s-hook', 'hook']]) {
    const el = document.getElementById(id)
    if (el && !el.readOnly) s[key] = el.value
  }
}

function swapArt() {
  const art = document.querySelector('.art')
  if (!art) return
  art.classList.add('swap')
  art.addEventListener('animationend', () => art.classList.remove('swap'), { once: true })
}

function pickTemplate(t) {
  const changed = t.id !== state.setup.tpl
  Object.assign(state.setup, { tpl: t.id, kind: t.kind, what: t.what, goal: t.goal, preset: t.preset })
  // the redraw reads the fields back in, so they have to hold the new template's values first
  const field = document.getElementById('s-what')
  if (field) field.value = t.what
  // force it: some browsers leave focus in the query field after a click, and a normal
  // render skips while a field has focus, which would leave the art on the old kind
  redraw()
  if (changed) swapArt()
}

async function testHook() {
  readSetupFields()
  const s = state.setup
  const url = s.hook.trim()
  if (!/^https:\/\/[^\s/]+\.[^\s]+/.test(url)) {
    s.test = { ok: false, text: 'Use a public HTTPS URL' }
    return render()
  }
  if (!s.locked) {
    // the monitor does not exist yet; the first check sends a signed test before it runs
    s.test = { ok: true, text: 'Looks right. A signed test is sent when the monitor is created' }
    return render()
  }
  s.test = { ok: null, text: 'Sending a test…' }
  render()
  try {
    const r = await slots.attachWebhook(url, s.locked)
    s.test = r.delivered ? { ok: true, text: `Delivered, ${r.status_code} in ${r.duration_ms} ms`, secret: r.secret } : { ok: false, text: `Not delivered: ${r.status_code ? 'answered ' + r.status_code : r.error}` }
  } catch (e) {
    s.test = { ok: false, text: e.message }
  }
  render()
}

function logLine(text, kind = 'now') {
  const s = state.setup
  if (!s) return
  for (const line of s.log) if (line.kind === 'now') line.kind = 'done'
  s.log.push({ text, kind })
  render()
}

// creates the monitor (unless setup is locked to one), tests the webhook, runs it once and follows the run
async function runFirstCheck() {
  const s = state.setup
  try {
    let monitor = s.locked
    if (monitor) s.monitorId = monitor.id
    else {
      const tpl = TEMPLATES.find((t) => t.id === s.tpl)
      const body = {
        name: tpl.id === 'custom' ? s.what.trim().slice(0, 60) || 'My monitor' : tpl.name,
        goal: s.goal.trim(),
        targets: s.kind === 'search' ? [{ type: 'search', query: s.what.trim() }] : s.what.split(/\s+/).filter(Boolean).map((url) => ({ type: 'page', url })),
        schedule: { type: 'interval', interval: s.preset },
      }
      if (s.hook.trim()) body.webhook = { url: s.hook.trim() }
      logLine('Creating the monitor')
      monitor = await api('POST', '/v1/monitors', body)
      s.monitorId = monitor.id
      if (monitor.webhook?.secret) toast('Webhook signing secret. It is shown only this once', { secret: monitor.webhook.secret })
      logLine(`Created “${monitor.name}”`, 'done')
      if (body.webhook) {
        const r = await api('POST', `/v1/monitors/${monitor.id}/webhook/test`)
        logLine(r.delivered ? `Webhook answered ${r.status_code} in ${r.duration_ms} ms` : `Webhook test failed: ${r.status_code ? 'answered ' + r.status_code : r.error}`, r.delivered ? 'done' : 'bad')
      }
    }
    s.monitorId = monitor.id
    logLine(s.kind === 'search' ? `Searching for “${s.what.trim()}”` : 'Fetching the page')
    const queued = await api('POST', `/v1/monitors/${monitor.id}/run`)
    let run = queued
    for (let i = 0; i < 120 && !finished(run) && state.setup === s; i++) {
      await sleep(1500)
      run = await api('GET', `/v1/monitors/${monitor.id}/runs/${queued.id}`)
      if (run.status === 'running' && i === 1) logLine('Judging against your goal')
    }
    if (run.status === 'failed') {
      logLine(run.error?.message ?? 'The run failed', 'bad')
      s.failed = true
    } else if (finished(run)) {
      const kept = run.counts.changes
      const text = s.kind === 'search' ? `${run.counts.candidates} new results judged, ${kept} kept` : kept ? `${kept} change${kept === 1 ? '' : 's'} kept` : 'Saved the page. Later runs compare against it'
      logLine(text, kept ? 'kept' : 'done')
    } else {
      logLine('Still running, it finishes in the background', 'done')
    }
  } catch (e) {
    logLine(e.message, 'bad')
    s.failed = true
  }
  for (const line of s.log) if (line.kind === 'now') line.kind = 'done'
  s.done = true
  if (state.setup === s) render()
}

function goSetupStep(step) {
  readSetupFields()
  state.setup.step = step
  render()
  if (step === 3) runFirstCheck()
}

// step art: a search typing out with results arriving, or a page being scanned
function watchArt(s) {
  if (s.kind === 'page') {
    const widths = [88, 64, 92, 40, 76, 84, 58, 70]
    const host = (s.what.split(/\s+/)[0] || 'https://example.com/changelog').replace(/^https?:\/\//, '')
    return h(
      'div',
      { class: 'art', 'aria-hidden': 'true' },
      h('div', { class: 'art-box' }, h('div', { class: 'page-frame', style: `--h:${widths.length * 16 + 40}px` }, h('div', { class: 'url', text: host }), widths.map((w, i) => h('i', { class: i === 4 ? 'changed' : null, style: `width:${w}%` })), h('span', { class: 'scan' }))),
    )
  }
  const q = s.what.trim() || 'what you would type into a search box'
  const sites = ['techcrunch.com', 'bloomberg.com', 'reuters.com', 'theinformation.com']
  // each result gets its own moment inside one 6s loop
  const css = sites.map((_, i) => {
    const from = 36 + i * 6
    return `@keyframes art-res${i} { 0%, ${from}% { opacity: 0; transform: translateY(6px); } ${from + 4}%, 92% { opacity: 1; transform: none; } 98%, 100% { opacity: 0; } }`
  })
  return h(
    'div',
    { class: 'art', 'aria-hidden': 'true' },
    h('style', { text: css.join('\n') }),
    h(
      'div',
      { class: 'art-box' },
      h('div', { class: 'searchbar' }, icon('search'), h('span', { class: 'typed', style: `--n:${q.length}`, text: q }), h('span', { class: 'caret' })),
      sites.map((site, i) =>
        h('div', { class: 'res', style: `animation: 6s linear infinite art-res${i}` }, h('span', { class: 'site', text: site[0].toUpperCase() }), h('span', { class: 'bars' }, h('i', { style: `width:${[78, 64, 84, 56][i]}%` }), h('i', { style: `width:${[46, 52, 38, 60][i]}%;opacity:0.5` })), h('span', { class: 'mono', text: site })),
      ),
    ),
  )
}

// step art: scores filling up against the threshold, the ones that pass turn green
function judgeArt() {
  const rows = [['Lambda raises $1.5B', 0.92], ['Top 10 AI tools', 0.41], ['Etched Series B', 0.78], ['GPU prices fall', 0.23], ['Chip export rules', 0.55]]
  const threshold = 0.7
  const css = rows.map(([, v], i) => {
    const from = 6 + i * 12
    const to = from + 10
    const end = v >= threshold ? 'var(--color-accent-fill)' : 'var(--color-text-3)'
    return `@keyframes art-fill${i} { 0%, ${from}% { width: 0; background: var(--color-text-3); } ${to}% { width: ${v * 100}%; background: var(--color-text-3); } ${to + 3}%, 90% { width: ${v * 100}%; background: ${end}; } 98%, 100% { width: 0; background: var(--color-text-3); } }`
  })
  // the track spans the middle column: after the 120px label and its 12px gap, before the 12px gap and 36px score
  return h(
    'div',
    { class: 'art', 'aria-hidden': 'true' },
    h('style', { text: css.join('\n') }),
    h(
      'div',
      { class: 'art-box' },
      h(
        'div',
        { class: 'scores' },
        h('span', { class: 'threshold', style: `left:calc(132px + (100% - 180px) * ${threshold})` }, h('span', { text: `threshold ${threshold}` })),
        rows.map(([title, v], i) => h('div', { class: 'score-row' }, h('span', { class: 't', text: title }), h('span', { class: 'track' }, h('span', { class: 'fill', style: `--v:${v * 100}%;animation: 6s linear infinite art-fill${i}` })), h('span', { class: 'mono', text: v.toFixed(2) }))),
      ),
    ),
  )
}

function setupScreen() {
  const s = state.setup
  const locked = Boolean(s.locked)
  const st = s.step
  const steps = ['What to watch', 'When to tell you', 'First check'].map((label, i) => h('span', { class: i + 1 === st ? 'now' : i + 1 < st ? 'done' : null, text: label }))
  let form

  if (st === 1) {
    // a locked setup shows the same four templates as the main app, with the one that
    // matches the monitor being followed selected
    const cards = TEMPLATES.map((t) => ({ ...t, enabled: !locked }))
    const match = TEMPLATES.find((t) => t.kind === s.kind && (t.what === s.what || t.goal === s.goal))
    const selected = locked ? (match ?? TEMPLATES.find((t) => t.kind === s.kind) ?? TEMPLATES[0]).id : s.tpl
    const whatField =
      s.kind === 'page' && !locked
        ? h('textarea', { class: 'input', id: 's-what', placeholder: 'https://', text: s.what })
        : h('input', { class: 'input', id: 's-what', value: s.what, readonly: locked, placeholder: s.kind === 'search' ? 'What would you type into a search box' : 'https://' })
    form = [
      h('h1', { text: 'What should it watch first' }),
      h('div', { class: 'tpls' }, cards.map((t) => h('button', { class: 'tpl', type: 'button', 'aria-pressed': String(t.id === selected), disabled: !t.enabled, onclick: t.enabled ? () => pickTemplate(t) : null }, h('b', { text: t.name }), h('span', { text: t.blurb }), h('span', { class: 'mono', text: t.kind === 'search' ? 'Web search' : 'Page' })))),
      h('div', { class: 'field' }, h('label', { for: 's-what', text: s.kind === 'search' ? 'Search query' : 'Page URL' }), whatField),
      h('div', { class: 'setup-actions' }, h('button', { class: 'btn primary', text: 'Continue', onclick: () => goSetupStep(2) }), h('button', { class: 'btn ghost', text: 'Skip to dashboard', onclick: () => finishSetup() })),
    ]
  } else if (st === 2) {
    const test = s.test
    const presets = locked && !PRESETS.some(([id]) => id === s.preset) ? [[s.preset, scheduleText(s.locked.schedule)]] : PRESETS
    form = [
      h('h1', { text: 'When is it worth telling you' }),
      h('div', { class: 'field' }, h('label', { for: 's-goal', text: 'What counts as a finding' }), h('textarea', { class: 'input', id: 's-goal', readonly: locked, placeholder: 'New funding rounds for GPU cloud companies', text: s.goal })),
      h('div', { class: 'field' }, h('label', { text: 'How often' }), h('div', { class: 'presets' }, presets.map(([id, label]) => h('button', { type: 'button', 'aria-pressed': String(s.preset === id), disabled: locked, onclick: locked ? null : () => (readSetupFields(), (s.preset = id), render()) }, label)))),
      h(
        'div',
        { class: 'field' },
        h('label', { for: 's-hook' }, 'Webhook URL ', h('span', { text: 'optional' })),
        h('div', { class: 'hook-row' }, h('input', { class: 'input', id: 's-hook', type: 'url', inputmode: 'url', placeholder: 'https://', value: s.hook, autocomplete: 'off' }), h('button', { class: 'btn', type: 'button', text: 'Send test', disabled: test?.ok === null, onclick: testHook })),
        test && h('span', { class: 'test-result' + (test.ok ? ' ok' : test.ok === false ? ' bad' : '') }, test.ok === null ? null : icon(test.ok ? 'check' : 'x'), test.text),
        test?.secret && [h('div', { class: 'secret' }, h('span', { text: test.secret }), h('button', { class: 'btn ghost', type: 'button', text: 'Copy', onclick: () => navigator.clipboard?.writeText(test.secret).catch(() => {}) })), h('small', { text: 'Verify deliveries with this signing secret. It is shown once.' })],
        webhookHint(),
      ),
      h('div', { class: 'setup-actions' }, h('button', { class: 'btn primary', text: 'Create and run first check', onclick: () => goSetupStep(3) }), h('button', { class: 'btn ghost', text: 'Back', onclick: () => goSetupStep(1) })),
    ]
  } else {
    const title = s.done ? (s.failed ? 'First check failed' : 'First check done') : 'Running the first check'
    form = [
      svg('svg', { class: 'ring' + (s.done ? ' done' : '') + (s.failed ? ' failed' : ''), viewBox: '0 0 72 72', 'aria-hidden': 'true' }, svg('circle', { class: 'bg', cx: 36, cy: 36, r: 32 }), svg('circle', { class: 'fg', cx: 36, cy: 36, r: 32 }), svg('path', { d: 'M24 37l8 8 16-17' })),
      h('h1', { text: title, 'aria-live': 'polite' }),
      h('div', { class: 'runlog' }, s.log.map((line) => h('div', { class: 'in' + (line.kind === 'now' ? ' now' : '') + (line.kind === 'bad' ? ' bad' : '') }, h('span', { class: 'pip' }), line.kind === 'kept' ? h('b', { text: line.text }) : h('span', { text: line.text })))),
      // the run carries on on the server, so the dashboard is open as soon as the monitor exists
      h('div', { class: 'setup-actions' }, h('button', { class: 'btn primary', text: 'Open dashboard', disabled: !s.done && !s.monitorId, onclick: () => finishSetup(s.monitorId) })),
    ]
  }

  // the screen is redrawn per step, so the bar starts where the last step left it and slides to the new width
  const bar = h('i', { style: `width:${s.shown}%` })
  const target = (st / 3) * 100
  requestAnimationFrame(() => requestAnimationFrame(() => (bar.style.width = target + '%')))
  s.shown = target

  return [
    strip(),
    h(
      'div',
      { class: 'setup' },
      h('div', { class: 'setup-top' }, h('div', { class: 'steps' }, steps)),
      h('div', { class: 'step-progress' }, bar),
      h('div', { class: 'setup-grid' + (st === 3 ? ' center' : '') }, h('div', { class: 'setup-form' }, form), st === 1 ? watchArt(s) : st === 2 ? judgeArt() : null),
    ),
  ]
}

// ---- render ----

function render() {
  // keep what someone is typing: the background refresh does not redraw while a field has focus
  const active = document.activeElement
  if (!render.force && state.session && app.contains(active) && active.matches('input, textarea')) return
  // carry over anything typed into the setup or the drawer, the redraw rebuilds those fields
  if (state.setup) readSetupFields()
  if (state.drawer && document.getElementById('d-name')) {
    for (const key of ['what', 'goal', 'name', 'hook', 'cron']) {
      const el = document.getElementById('d-' + key)
      if (el) state.drawer.typed[key] = el.value
    }
  }
  let screen
  if (!state.session) screen = signInScreen()
  else if (state.setup) screen = setupScreen()
  else screen = [strip(), dashboard()]
  app.replaceChildren(...[screen].flat(3).filter(Boolean))
  state.ready = true
  // each page and drawer gets its own address, so reload, links and Back land in the same place
  if (state.session && !state.setup && routed && location.hash !== hashFor()) history.pushState(null, '', hashFor())
  document.dispatchEvent(new CustomEvent('om:render', { detail: { session: state.session } }))
}

// for add-ons and actions that must redraw even while a field has focus
function redraw() {
  render.force = true
  try {
    render()
  } finally {
    render.force = false
  }
}

async function boot() {
  routed = false
  try {
    state.session = { role: 'owner', ...(await api('GET', '/auth/session')) }
  } catch {
    state.session = null
  }
  if (state.session) await loadAll()
  else render()
}

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return
  if (state.drawer) closeDrawer()
  else if (state.sheet) {
    state.sheet = false
    render()
  }
})

// add-ons hook in through this object and the "om:render" event
window.openMonitor = { state, slots, api, h, svg, icon, toast, signInForm, render: redraw, reload: loadAll, boot }
boot()
