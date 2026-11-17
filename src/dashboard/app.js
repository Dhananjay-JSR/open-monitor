// Dashboard. Plain DOM, no framework, no build step.
// Everything that comes from the API (titles, snippets, diffs) is inserted as text, never as html.

const DAY_MS = 24 * 60 * 60 * 1000
const SVG_NS = 'http://www.w3.org/2000/svg'
const app = document.getElementById('app')

const state = {
  session: null,
  monitors: [],
  runs: {}, // monitor id -> runs, newest first
  deliveries: {}, // monitor id -> delivery attempts
  selected: null,
  creating: false,
  notice: null, // { kind, text }
  loadError: null,
}
let refreshTimer = null

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
  for (const child of children.flat()) {
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

const isOwner = () => state.session?.role === 'owner'
const clock = (iso) => new Date(iso).toLocaleTimeString([], { hour12: false })
const dayLabel = (iso) => new Date(iso).toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long' })
const dateTime = (iso) => (iso ? new Date(iso).toLocaleString([], { hour12: false }) : 'not scheduled')

function scheduleText(schedule) {
  if (schedule.type === 'interval') return 'every ' + schedule.interval
  return `${schedule.cron} (${schedule.timezone})`
}

function targetText(monitor) {
  const first = monitor.targets[0]
  if (first.type === 'search') return 'search'
  return monitor.targets.length === 1 ? '1 page' : monitor.targets.length + ' pages'
}

// which mark a run gets: the shape tells the story (see the legend in the log header)
function runMark(run) {
  if (run.status === 'succeeded') return run.counts.changes > 0 ? 'changes' : 'succeeded'
  return run.status
}

function mark(status) {
  return h('span', { class: 'mark', 'data-status': status, role: 'img', 'aria-label': status })
}

// ---- data ----

async function loadAll() {
  try {
    const list = await api('GET', '/v1/monitors?limit=100')
    state.monitors = list.data
    await Promise.all(
      state.monitors.map(async (monitor) => {
        const runs = await api('GET', `/v1/monitors/${monitor.id}/runs?limit=50`)
        state.runs[monitor.id] = runs.data
        // the delivery log is owner-only on some setups, so a refusal is not an error here
        const attempts = await api('GET', `/v1/monitors/${monitor.id}/deliveries?limit=50`).catch(() => ({ data: [] }))
        state.deliveries[monitor.id] = attempts.data
      }),
    )
    state.loadError = null
  } catch (e) {
    if (e.status === 401) {
      state.session = null
    } else {
      state.loadError = e.message
    }
  }
  render()
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
  state.notice = null
  try {
    const message = (await fn()) ?? done
    if (typeof message === 'string') state.notice = { kind: 'info', text: message }
  } catch (e) {
    state.notice = { kind: 'error', text: e.message }
  }
  await loadAll()
}

// ---- traces ----

const TRACE_W = 480
const TRACE_H = 56
const BASELINE = 42

function trace(monitor, runs) {
  const now = Date.now()
  const start = now - DAY_MS
  const x = (iso) => ((Date.parse(iso) - start) / DAY_MS) * TRACE_W
  const recent = runs.filter((r) => Date.parse(r.created_at) >= start)

  const grid = svg('g', { class: 'trace-grid' })
  for (const gx of [120, 240, 360]) grid.append(svg('line', { x1: gx, y1: 0, x2: gx, y2: TRACE_H }))
  const root = svg('svg', { class: 'trace', viewBox: `0 0 ${TRACE_W} ${TRACE_H}`, preserveAspectRatio: 'none', role: 'img' }, grid)

  if (monitor.status === 'paused') {
    // we only know when the monitor last changed, which is when it was paused
    const from = Math.max(0, x(monitor.updated_at))
    root.append(svg('rect', { class: 'trace-paused', x: from, y: 0, width: TRACE_W - from, height: TRACE_H }))
  }
  root.append(svg('line', { class: 'trace-base', x1: 0, y1: BASELINE, x2: TRACE_W, y2: BASELINE }))

  let kept = 0
  let failed = 0
  for (const run of recent) {
    const at = x(run.created_at)
    const status = runMark(run)
    if (status === 'changes') {
      kept++
      const height = Math.min(36, 12 + run.counts.changes * 6) // taller for more changes
      root.append(svg('line', { class: 'trace-change', x1: at, y1: BASELINE, x2: at, y2: BASELINE - height }))
    } else if (status === 'failed') {
      failed++
      root.append(svg('line', { class: 'trace-fail', x1: at - 4, y1: 46, x2: at + 4, y2: 54 }))
      root.append(svg('line', { class: 'trace-fail', x1: at + 4, y1: 46, x2: at - 4, y2: 54 }))
    } else if (status === 'succeeded') {
      root.append(svg('line', { class: 'trace-run', x1: at, y1: BASELINE, x2: at, y2: BASELINE - 8 }))
    }
  }
  root.setAttribute('aria-label', `Last 24 hours: ${recent.length} runs, ${kept} with kept changes, ${failed} failed`)
  return root
}

// ---- monitor detail and actions ----

function detail(monitor) {
  const first = monitor.targets[0]
  const facts = h('dl', { class: 'facts' })
  const fact = (name, value, data) => facts.append(h('dt', { text: name }), h('dd', { class: data ? 'data' : null, text: value }))

  if (first.type === 'search') fact('Query', first.query)
  else fact('Pages', monitor.targets.map((t) => t.url).join('\n'), true)
  fact('Schedule', scheduleText(monitor.schedule))
  fact('Next run', dateTime(monitor.next_run_at), true)
  if (monitor.pause_reason) fact('Paused because', monitor.pause_reason)
  if (monitor.webhook) fact('Webhook', monitor.webhook.url, true)
  fact('ID', monitor.id, true)

  const path = `/v1/monitors/${monitor.id}`
  const buttons = []
  if (monitor.status === 'active' && state.session.can_run !== false) {
    buttons.push(
      h('button', {
        class: 'btn btn-primary',
        text: monitor.current_run_id ? 'Running' : 'Run now',
        'aria-busy': monitor.current_run_id ? 'true' : null,
        disabled: Boolean(monitor.current_run_id),
        onclick: () => act(() => api('POST', path + '/run').then(() => undefined)),
      }),
    )
  }
  if (isOwner()) {
    if (monitor.status === 'active') {
      buttons.push(h('button', { class: 'btn', text: 'Pause', onclick: () => act(() => api('POST', path + '/pause').then(() => undefined)) }))
    } else {
      buttons.push(h('button', { class: 'btn btn-primary', text: 'Resume', onclick: () => act(() => api('POST', path + '/resume').then(() => undefined)) }))
    }
    if (monitor.webhook) {
      buttons.push(
        h('button', {
          class: 'btn btn-quiet',
          text: 'Test webhook',
          onclick: () =>
            act(async () => {
              const result = await api('POST', path + '/webhook/test')
              if (!result.delivered) {
                throw new Error(`Webhook test failed: ${result.error}${result.status_code ? ' ' + result.status_code : ''}`)
              }
              return `Webhook answered ${result.status_code} in ${result.duration_ms} ms`
            }),
        }),
      )
    }
    buttons.push(
      h('button', {
        class: 'btn btn-danger',
        text: 'Delete',
        onclick: () => {
          if (!confirm(`Delete "${monitor.name}" and its run history?`)) return
          state.selected = null
          act(() => api('DELETE', path).then(() => undefined), 'Monitor deleted')
        },
      }),
    )
  }

  return h('div', { class: 'detail' }, h('p', { text: monitor.goal || 'No goal set. The judge keeps anything substantive.' }), facts, h('div', { class: 'btn-row' }, buttons))
}

function lanes() {
  if (state.loadError) {
    return h('div', { class: 'state', 'data-kind': 'error' }, h('strong', { text: 'Could not load monitors' }), state.loadError, ' ', h('button', { class: 'btn btn-quiet', text: 'Try again', onclick: loadAll }))
  }
  if (state.monitors.length === 0) {
    const hint = isOwner() ? 'Create a monitor and its first run appears here within a minute.' : 'The owner has not set up any monitors.'
    return h('div', { class: 'state' }, h('strong', { text: 'Nothing is being watched yet' }), hint)
  }

  const list = h('ul', { class: 'lanes' })
  for (const monitor of state.monitors) {
    const open = state.selected === monitor.id
    const meta = `${targetText(monitor)} · ${scheduleText(monitor.schedule)}`
    const name = h('span', {}, h('span', { class: 'lane-name', text: monitor.name }), monitor.status === 'paused' && [' ', h('span', { class: 'tag', 'data-status': 'paused', text: 'paused' })], h('br'), h('span', { class: 'lane-meta', text: meta }))
    const button = h(
      'button',
      {
        class: 'lane-button',
        'aria-expanded': String(open),
        onclick: () => {
          state.selected = open ? null : monitor.id
          render()
        },
      },
      name,
      trace(monitor, state.runs[monitor.id] ?? []),
    )
    list.append(h('li', { class: 'lane', 'aria-current': open ? 'true' : null }, button, open && detail(monitor)))
  }
  const axis = h('div', { class: 'axis data' }, ...['24h ago', '18h', '12h', '6h', 'now'].map((label) => h('span', { text: label })))
  return [list, axis]
}

// ---- create form ----

function field(id, label, control, help) {
  return h('div', { class: 'field' }, h('label', { for: id, text: label }), control, help && h('span', { class: 'help', text: help }))
}

function createForm() {
  const name = h('input', { class: 'input', id: 'new-name', required: true, maxlength: 256, autocomplete: 'off' })
  const type = h('select', { class: 'input', id: 'new-type' }, h('option', { value: 'search', text: 'Web search results' }), h('option', { value: 'page', text: 'Specific pages' }))
  const what = h('textarea', { class: 'input', id: 'new-what', required: true })
  const whatLabel = h('label', { for: 'new-what', text: 'Search query' })
  const goal = h('textarea', { class: 'input', id: 'new-goal', maxlength: 2000 })
  const schedule = h('input', { class: 'input', id: 'new-schedule', value: '1d', required: true, autocomplete: 'off' })
  const hook = h('input', { class: 'input', id: 'new-hook', type: 'url', inputmode: 'url', autocomplete: 'off' })
  const error = h('p', { class: 'error', role: 'alert' })

  type.addEventListener('change', () => {
    whatLabel.textContent = type.value === 'search' ? 'Search query' : 'Page URLs, one per line (up to 10)'
  })

  async function submit(event) {
    event.preventDefault()
    error.textContent = ''
    const text = what.value.trim()
    const sched = schedule.value.trim()
    const body = {
      name: name.value,
      goal: goal.value,
      targets: type.value === 'search' ? [{ type: 'search', query: text }] : text.split(/\s+/).map((url) => ({ type: 'page', url })),
      // a cron line has spaces in it, an interval like "6h" does not
      schedule: sched.includes(' ') ? { type: 'cron', cron: sched } : { type: 'interval', interval: sched },
    }
    if (hook.value) body.webhook = { url: hook.value }

    try {
      const created = await api('POST', '/v1/monitors', body)
      state.creating = false
      state.selected = created.id
      if (created.webhook?.secret) {
        state.notice = { kind: 'info', text: 'Webhook signing secret, shown only this once: ' + created.webhook.secret }
      }
      await loadAll()
    } catch (e) {
      error.textContent = e.message
    }
  }

  return h(
    'form',
    { class: 'detail', onsubmit: submit },
    h('h3', { text: 'New monitor' }),
    field('new-name', 'Name', name),
    field('new-type', 'Watches', type),
    h('div', { class: 'field' }, whatLabel, what),
    field('new-goal', 'Goal', goal, 'What counts as worth an alert. The judge scores every finding against this.'),
    field('new-schedule', 'Schedule', schedule, 'An interval like 15m, 1h, 1d, 1w, or a cron line like 0 9 * * 1-5'),
    field('new-hook', 'Webhook URL (optional)', hook),
    error,
    h('div', { class: 'btn-row' }, h('button', { class: 'btn btn-primary', text: 'Create monitor' }), h('button', { class: 'btn', type: 'button', text: 'Cancel', onclick: () => ((state.creating = false), render()) })),
  )
}

// ---- log ----

function changeView(change) {
  // only http(s) links become clickable, anything else stays plain text
  const safe = /^https?:\/\//i.test(change.url)
  const title = safe ? h('a', { href: change.url, target: '_blank', rel: 'noopener noreferrer', text: change.title || change.url }) : h('span', { text: change.title || change.url })
  const percent = Math.round(change.confidence * 100)
  const confidence = h('span', { class: 'confidence data' }, h('span', { class: 'confidence-bar' }, h('span', { style: `width:${percent}%` })), change.confidence.toFixed(2))

  let body
  if (change.type === 'page_change') {
    const lines = change.diff.unified.split('\n').filter((line) => line !== '')
    body = h('pre', { class: 'diff', tabindex: 0 }, lines.map((line) => h('span', { class: line.startsWith('@@') ? 'hunk' : line[0] === '+' ? 'add' : line[0] === '-' ? 'del' : null, text: line })))
    if (change.diff.truncated) body = [body, h('div', { class: 'muted', text: 'Diff cut at 24 KiB.' })]
  } else {
    body = h('div', { class: 'muted', text: change.snippet || '' })
  }
  return h('div', { class: 'change' }, title, ' ', confidence, body)
}

function runSummary(run) {
  if (run.status === 'queued') return 'queued'
  if (run.status === 'running') return 'running'
  if (run.status === 'skipped') return 'skipped'
  const trigger = run.trigger === 'schedule' ? 'scheduled' : run.trigger
  if (run.status === 'failed') return trigger
  if (run.counts.changes === 0) return `${trigger} · nothing new`
  return `${trigger} · ${run.counts.candidates} candidates, ${run.counts.changes} kept`
}

function logEntry(entry) {
  const { run, monitor } = entry
  const body = h('div', { class: 'entry-body' }, h('span', { class: 'entry-title', text: monitor.name }), ' ', h('span', { class: 'muted', text: '· ' + runSummary(run) }))

  if (run.error) {
    body.append(' ', h('span', { class: 'tag', 'data-status': 'failed', text: run.error.code ?? run.error.skip_reason ?? 'error' }))
    body.append(h('div', { class: 'muted', text: run.error.message }))
  }
  for (const targetError of run.target_errors) {
    body.append(h('div', { class: 'muted data', text: `${targetError.url}: ${targetError.message}` }))
  }
  body.append(...run.changes.map(changeView))

  const attempts = (state.deliveries[monitor.id] ?? []).filter((a) => a.run_id === run.id).reverse()
  for (const attempt of attempts) {
    const outcome = attempt.delivered ? `${attempt.status_code} in ${attempt.duration_ms} ms` : `failed (${attempt.error}${attempt.status_code ? ' ' + attempt.status_code : ''})`
    body.append(h('div', { class: 'muted data', text: `webhook → ${attempt.target_host} · attempt ${attempt.attempt} · ${outcome}` }))
  }
  if (run.trace_id && (run.changes.length > 0 || run.error)) {
    body.append(h('div', { class: 'muted data', text: 'trace ' + run.trace_id }))
  }

  return h('li', { class: 'entry' }, h('span', { class: 'entry-time data', text: clock(run.created_at) }), mark(runMark(run)), body)
}

function log() {
  const entries = []
  for (const monitor of state.monitors) {
    for (const run of state.runs[monitor.id] ?? []) entries.push({ run, monitor })
  }
  entries.sort((a, b) => (a.run.created_at < b.run.created_at ? 1 : -1))

  if (entries.length === 0) {
    return h('div', { class: 'state' }, h('strong', { text: 'The log is empty' }), 'Runs are written here as they happen, newest first.')
  }
  const list = h('ol', { class: 'log-entries' })
  let lastDay = null
  for (const entry of entries.slice(0, 200)) {
    const day = dayLabel(entry.run.created_at)
    if (day !== lastDay) {
      list.append(h('li', { class: 'entry-day', text: day }))
      lastDay = day
    }
    list.append(logEntry(entry))
  }
  return list
}

// ---- screens ----

function loginScreen() {
  const username = h('input', { class: 'input', id: 'login-user', autocomplete: 'username', required: true })
  const password = h('input', { class: 'input', id: 'login-pass', type: 'password', autocomplete: 'current-password', required: true })
  const error = h('span', { class: 'error', id: 'login-error', role: 'alert' })
  const button = h('button', { class: 'btn btn-primary', text: 'Sign in' })

  async function submit(event) {
    event.preventDefault()
    error.textContent = ''
    password.removeAttribute('aria-invalid')
    button.setAttribute('aria-busy', 'true')
    try {
      await api('POST', '/auth/login', { username: username.value, password: password.value })
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

  // the login picture is the product's own trace: quiet ticks, and a tall mark where something changed
  const picture = svg('svg', { viewBox: '0 0 720 400', preserveAspectRatio: 'xMidYMid slice', role: 'img', 'aria-label': 'A recorder trace with tall marks where changes were kept' })
  const grid = svg('g', { class: 'trace-grid' })
  for (const y of [80, 160, 240, 320]) grid.append(svg('line', { x1: 0, y1: y, x2: 720, y2: y }))
  for (const gx of [120, 240, 360, 480, 600]) grid.append(svg('line', { x1: gx, y1: 0, x2: gx, y2: 400 }))
  picture.append(grid, svg('line', { class: 'trace-base', x1: 0, y1: 280, x2: 720, y2: 280 }))
  for (const gx of [40, 100, 160, 280, 340, 400, 520, 640, 700]) picture.append(svg('line', { class: 'trace-run', x1: gx, y1: 280, x2: gx, y2: 250 }))
  for (const [gx, top] of [[220, 130], [460, 60], [580, 180]]) picture.append(svg('line', { class: 'trace-change', x1: gx, y1: 280, x2: gx, y2: top }))

  return h(
    'div',
    { class: 'login' },
    h('div', { class: 'login-trace' }, picture),
    h(
      'form',
      { class: 'login-form', onsubmit: submit },
      h('h1', { text: 'Sign in to open-monitor', style: 'margin-bottom: var(--space-4)' }),
      h('div', { class: 'field' }, h('label', { for: 'login-user', text: 'Username' }), username),
      h('div', { class: 'field' }, h('label', { for: 'login-pass', text: 'Password' }), password, error),
      button,
      h('div', { id: 'login-extra' }), // add-ons can put something here
    ),
  )
}

function brandMark() {
  const el = svg('svg', { class: 'brand-mark', viewBox: '0 0 36 20', 'aria-hidden': 'true' })
  el.append(svg('line', { class: 'trace-base', x1: 0, y1: 16, x2: 36, y2: 16 }))
  for (const gx of [5, 12, 28]) el.append(svg('line', { class: 'trace-run', x1: gx, y1: 16, x2: gx, y2: 11 }))
  el.append(svg('line', { class: 'trace-change', x1: 20, y1: 16, x2: 20, y2: 2 }))
  return el
}

function mainScreen() {
  const topbar = h(
    'header',
    { class: 'topbar' },
    h('h1', {}, brandMark(), 'open-monitor'),
    h('span', { class: 'muted', text: state.session.username }),
    h('button', {
      class: 'btn btn-quiet',
      text: 'Sign out',
      onclick: async () => {
        await api('POST', '/auth/logout').catch(() => {})
        state.session = null
        boot()
      },
    }),
  )

  const banners = []
  if (!state.session.judge_configured) {
    banners.push(h('div', { class: 'banner', role: 'status' }, h('strong', { text: 'No LLM is configured.' }), h('span', {}, 'Every run will fail until the server has ', h('code', { text: 'LLM_API_KEY' }), ', ', h('code', { text: 'LLM_BASE_URL' }), ' or ', h('code', { text: 'LLM_COMMAND' }), '.')))
  }
  if (state.notice) {
    banners.push(
      h('div', { class: 'banner', 'data-kind': state.notice.kind, role: 'status' }, h('span', { text: state.notice.text, style: 'overflow-wrap:anywhere' }), h('button', { class: 'btn btn-quiet', text: 'Dismiss', onclick: () => ((state.notice = null), render()) })),
    )
  }

  const tracesHead = h('div', { class: 'section-head' }, h('h2', { text: 'Traces' }), h('span', { class: 'muted', text: 'last 24 hours' }), isOwner() && !state.creating && h('button', { class: 'btn btn-primary', text: 'New monitor', onclick: () => ((state.creating = true), render()) }))
  const traces = h('section', {}, tracesHead, state.creating && createForm(), lanes())
  const logSection = h('section', { class: 'log' }, h('div', { class: 'section-head' }, h('h2', { text: 'Log' }), h('span', { class: 'muted', text: 'everything, newest first' })), log())

  return [topbar, banners, h('div', { id: 'addon' }), h('main', { class: 'shell' }, traces, logSection)]
}

function render() {
  // keep what the user is typing: don't redraw while the create form has focus
  if (state.session && state.creating && app.querySelector('form.detail')?.contains(document.activeElement)) return
  app.replaceChildren(...[state.session ? mainScreen() : loginScreen()].flat(2).filter(Boolean))
  document.dispatchEvent(new CustomEvent('om:render', { detail: { session: state.session } }))
}

async function boot() {
  try {
    state.session = { role: 'owner', ...(await api('GET', '/auth/session')) }
  } catch {
    state.session = null
  }
  if (state.session) await loadAll()
  else render()
}

// add-ons hook in through this object and the "om:render" event
window.openMonitor = { state, api, h, render, reload: loadAll, boot }
boot()
