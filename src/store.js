// Storage layer. `db` is a small adapter with three methods:
//   all(sql, params) -> rows
//   run(sql, params) -> { changes }
//   batch([[sql, params], ...]) -> runs everything atomically
import { SCHEMA } from './schema.js'

export function migrate(db) {
  return db.batch(SCHEMA.map((sql) => [sql, []]))
}

function placeholders(n) {
  return Array(n).fill('?').join(',')
}

// the API leaves out fields that don't apply instead of returning null
export function dropNulls(obj) {
  const out = {}
  for (const [key, value] of Object.entries(obj)) {
    if (value !== null && value !== undefined) out[key] = value
  }
  return out
}

function lastRunOf(lastRuns, monitorId) {
  const run = lastRuns.find((r) => r.monitor_id === monitorId)
  if (!run) return null
  return { id: run.id, status: run.status, change_count: run.change_count, finished_at: run.finished_at }
}

function targetFromRow(row, domains) {
  const target = { type: row.type }
  if (row.type === 'search') {
    const mine = domains.filter((d) => d.monitor_id === row.monitor_id)
    target.query = row.query
    target.max_results = row.max_results
    target.filters = {
      freshness: row.freshness.split(','),
      include_domains: mine.filter((d) => d.kind === 'include').map((d) => d.domain),
      exclude_domains: mine.filter((d) => d.kind === 'exclude').map((d) => d.domain),
    }
  } else {
    target.url = row.url
  }
  if (row.judge_threshold !== null) target.judge = { threshold: row.judge_threshold }
  return target
}

// Turns monitor rows into full objects. Child tables are fetched with IN (...) so a list
// of 100 monitors is still 4 queries. Keep it to 100 rows max, D1 caps bound params at 100.
async function loadMonitors(db, rows) {
  if (rows.length === 0) return []
  const ids = rows.map((r) => r.id)
  const marks = placeholders(ids.length)

  const targets = await db.all(
    `SELECT * FROM monitor_targets WHERE monitor_id IN (${marks}) ORDER BY position`,
    ids,
  )
  const domains = await db.all(
    `SELECT * FROM monitor_domains WHERE monitor_id IN (${marks}) ORDER BY rowid`,
    ids,
  )
  const metadata = await db.all(
    `SELECT * FROM monitor_metadata WHERE monitor_id IN (${marks}) ORDER BY rowid`,
    ids,
  )
  const activeRuns = await db.all(
    `SELECT id, monitor_id FROM runs WHERE monitor_id IN (${marks}) AND status IN ('queued', 'running')`,
    ids,
  )
  // last_run is the newest succeeded or failed run. A monitor never has two runs at once,
  // so the newest one by id is also the one that finished last.
  const lastRuns = await db.all(
    `SELECT r.id, r.monitor_id, r.status, r.change_count, r.finished_at FROM runs r
     WHERE r.monitor_id IN (${marks}) AND r.id = (
       SELECT max(id) FROM runs
       WHERE monitor_id = r.monitor_id AND status IN ('succeeded', 'failed')
     )`,
    ids,
  )

  return rows.map((row) => {
    const meta = {}
    for (const m of metadata) {
      if (m.monitor_id === row.id) meta[m.key] = m.value
    }

    let schedule
    if (row.schedule_type === 'interval') {
      schedule = { type: 'interval', interval: row.schedule_value }
    } else {
      schedule = { type: 'cron', cron: row.schedule_value, timezone: row.schedule_timezone }
    }

    let webhook = null
    if (row.webhook_url) {
      webhook = { url: row.webhook_url, events: row.webhook_events.split(',') }
    }

    return {
      id: row.id,
      name: row.name,
      goal: row.goal,
      targets: targets.filter((t) => t.monitor_id === row.id).map((t) => targetFromRow(t, domains)),
      schedule,
      webhook,
      metadata: meta,
      status: row.status,
      pause_reason: row.pause_reason,
      current_run_id: activeRuns.find((r) => r.monitor_id === row.id)?.id ?? null,
      next_run_at: row.next_run_at,
      last_run: lastRunOf(lastRuns, row.id),
      created_at: row.created_at,
      updated_at: row.updated_at,

      // internal, never sent to clients
      secret: row.webhook_secret,
      old_secret: row.webhook_old_secret,
      old_secret_until: row.webhook_old_secret_until,
      window_to: row.window_to,
      fail_streak: row.fail_streak,
      version: row.version,
      idem_hash: row.idem_hash,
    }
  })
}

export async function getMonitor(db, id) {
  const rows = await db.all('SELECT * FROM monitors WHERE id = ?', [id])
  return (await loadMonitors(db, rows))[0]
}

export async function getMonitorByIdemKey(db, key) {
  const rows = await db.all('SELECT * FROM monitors WHERE idem_key = ?', [key])
  return (await loadMonitors(db, rows))[0]
}

// newest first; '~' sorts after any id so no cursor means "from the top"
export async function listMonitors(db, after, limit) {
  const rows = await db.all('SELECT * FROM monitors WHERE id < ? ORDER BY id DESC LIMIT ?', [
    after ?? '~',
    limit + 1,
  ])
  return {
    data: await loadMonitors(db, rows.slice(0, limit)),
    has_more: rows.length > limit,
  }
}

// Takes the oldest monitor that is due and not already running, and marks it as running,
// in one statement so two ticks can never take the same one. Returns the monitor or undefined.
const NO_ACTIVE_RUN = `NOT EXISTS (
  SELECT 1 FROM runs r WHERE r.monitor_id = m.id AND r.status IN ('queued', 'running')
)`

// Takes the oldest monitor that is due and has no active run, by creating its run row.
// One statement, so there is nothing for a crash to split; OR IGNORE plus the unique index
// means two ticks can never both get the same monitor. Returns the monitor or undefined.
export async function claimNextDue(db, run) {
  const result = await db.run(
    `INSERT OR IGNORE INTO runs (id, monitor_id, trigger_kind, status, created_at, started_at)
     SELECT ?, m.id, 'schedule', 'running', ?, ?
     FROM monitors m
     WHERE m.status = 'active' AND m.next_run_at <= ? AND ${NO_ACTIVE_RUN}
     ORDER BY m.next_run_at
     LIMIT 1`,
    [run.id, run.created_at, run.started_at, run.created_at],
  )
  if (result.changes === 0) return undefined
  const rows = await db.all('SELECT monitor_id FROM runs WHERE id = ?', [run.id])
  return getMonitor(db, rows[0].monitor_id)
}

// Queues a manual run, unless the monitor already has an active one. Returns true if queued.
export async function claimManualRun(db, run) {
  const result = await db.run(
    `INSERT OR IGNORE INTO runs (id, monitor_id, trigger_kind, status, created_at)
     SELECT ?, m.id, 'manual', 'queued', ?
     FROM monitors m
     WHERE m.id = ? AND m.status = 'active' AND ${NO_ACTIVE_RUN}`,
    [run.id, run.created_at, run.monitor_id],
  )
  return result.changes === 1
}

export async function activeRunId(db, monitorId) {
  const rows = await db.all(
    `SELECT id FROM runs WHERE monitor_id = ? AND status IN ('queued', 'running')`,
    [monitorId],
  )
  return rows[0]?.id ?? null
}

function scheduleColumns(schedule) {
  if (schedule.type === 'interval') return ['interval', schedule.interval, null]
  return ['cron', schedule.cron, schedule.timezone]
}

// statements that replace a monitor's targets, domains and metadata
function childStatements(m) {
  const statements = [
    ['DELETE FROM monitor_targets WHERE monitor_id = ?', [m.id]],
    ['DELETE FROM monitor_domains WHERE monitor_id = ?', [m.id]],
    ['DELETE FROM monitor_metadata WHERE monitor_id = ?', [m.id]],
  ]

  m.targets.forEach((t, position) => {
    statements.push([
      `INSERT INTO monitor_targets
        (monitor_id, position, type, query, max_results, freshness, url, judge_threshold)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        m.id,
        position,
        t.type,
        t.query ?? null,
        t.max_results ?? null,
        t.filters ? t.filters.freshness.join(',') : null,
        t.url ?? null,
        t.judge?.threshold ?? null,
      ],
    ])
    if (!t.filters) return
    for (const domain of t.filters.include_domains) {
      statements.push(['INSERT INTO monitor_domains (monitor_id, kind, domain) VALUES (?, ?, ?)', [m.id, 'include', domain]])
    }
    for (const domain of t.filters.exclude_domains) {
      statements.push(['INSERT INTO monitor_domains (monitor_id, kind, domain) VALUES (?, ?, ?)', [m.id, 'exclude', domain]])
    }
  })

  for (const [key, value] of Object.entries(m.metadata)) {
    statements.push(['INSERT INTO monitor_metadata (monitor_id, key, value) VALUES (?, ?, ?)', [m.id, key, value]])
  }
  return statements
}

export function insertMonitor(db, m, idemKey) {
  const insert = [
    `INSERT INTO monitors
      (id, name, goal, schedule_type, schedule_value, schedule_timezone, status, next_run_at,
       webhook_url, webhook_events, webhook_secret, idem_key, idem_hash, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      m.id,
      m.name,
      m.goal,
      ...scheduleColumns(m.schedule),
      m.status,
      m.next_run_at,
      m.webhook ? m.webhook.url : null,
      m.webhook ? m.webhook.events.join(',') : null,
      m.secret ?? null,
      idemKey ?? null,
      m.idem_hash ?? null,
      m.created_at,
      m.updated_at,
    ],
  ]
  return db.batch([insert, ...childStatements(m)])
}

// Saves the editable fields. Returns false if the monitor changed since `m` was loaded.
export async function updateMonitor(db, m, removedPageUrls = []) {
  const result = await db.run(
    `UPDATE monitors SET
       name = ?, goal = ?, schedule_type = ?, schedule_value = ?, schedule_timezone = ?, next_run_at = ?,
       webhook_url = ?, webhook_events = ?, webhook_secret = ?, webhook_old_secret = ?,
       webhook_old_secret_until = ?, updated_at = ?, version = version + 1
     WHERE id = ? AND version = ?`,
    [
      m.name,
      m.goal,
      ...scheduleColumns(m.schedule),
      m.next_run_at,
      m.webhook ? m.webhook.url : null,
      m.webhook ? m.webhook.events.join(',') : null,
      m.secret ?? null,
      m.old_secret ?? null,
      m.old_secret_until ?? null,
      m.updated_at,
      m.id,
      m.version,
    ],
  )
  if (result.changes === 0) return false

  // FIXME: not in the same transaction as the UPDATE above. A D1 batch can't bail out
  // on "0 rows changed", so the version check has to happen first.
  const statements = childStatements(m)
  for (const url of removedPageUrls) {
    statements.push(['DELETE FROM page_baselines WHERE monitor_id = ? AND url = ?', [m.id, url]])
  }
  await db.batch(statements)
  return true
}

export function deleteMonitor(db, id) {
  const ownRuns = 'SELECT id FROM runs WHERE monitor_id = ?'
  const tables = [
    'runs',
    'monitor_targets',
    'monitor_domains',
    'monitor_metadata',
    'seen_urls',
    'page_baselines',
    'deliveries',
    'delivery_attempts',
  ]
  return db.batch([
    [`DELETE FROM run_changes WHERE run_id IN (${ownRuns})`, [id]],
    [`DELETE FROM run_target_errors WHERE run_id IN (${ownRuns})`, [id]],
    ...tables.map((table) => [`DELETE FROM ${table} WHERE monitor_id = ?`, [id]]),
    ['DELETE FROM monitors WHERE id = ?', [id]],
  ])
}

function changeFromRow(row) {
  let diff = null
  if (row.diff_unified !== null) {
    diff = {
      unified: row.diff_unified,
      added_lines: row.diff_added,
      removed_lines: row.diff_removed,
      truncated: Boolean(row.diff_truncated),
    }
  }
  return dropNulls({
    id: row.id,
    type: row.type,
    url: row.url,
    title: row.title,
    snippet: row.snippet,
    confidence: row.confidence,
    published_at: row.published_at,
    last_updated_at: row.last_updated_at,
    diff,
    previous_fetched_at: row.previous_fetched_at,
    fetched_at: row.fetched_at,
  })
}

async function loadRuns(db, rows) {
  if (rows.length === 0) return []
  const ids = rows.map((r) => r.id)
  const marks = placeholders(ids.length)
  const changes = await db.all(`SELECT * FROM run_changes WHERE run_id IN (${marks}) ORDER BY position`, ids)
  const errors = await db.all(`SELECT * FROM run_target_errors WHERE run_id IN (${marks}) ORDER BY position`, ids)

  return rows.map((row) => {
    let error = null
    if (row.error_message !== null) {
      error = dropNulls({ code: row.error_code, skip_reason: row.skip_reason, message: row.error_message })
    }
    return dropNulls({
      id: row.id,
      object: 'monitor.run',
      monitor_id: row.monitor_id,
      trigger: row.trigger_kind,
      status: row.status,
      window: row.window_to ? { from: row.window_from, to: row.window_to } : null,
      counts: { candidates: row.candidates, changes: row.change_count, errors: row.errors },
      usage: {
        fetched_urls: row.fetched_urls,
        cost: { total_cost: row.total_cost, currency: 'USD' },
      },
      changes: changes.filter((c) => c.run_id === row.id).map(changeFromRow),
      target_errors: errors
        .filter((e) => e.run_id === row.id)
        .map((e) => dropNulls({ type: 'page', url: e.url, code: e.code, status_code: e.status_code, message: e.message })),
      error,
      created_at: row.created_at,
      finished_at: row.finished_at,
      trace_id: row.trace_id, // not in the Perplexity API, handy for finding the run in a tracing tool
    })
  })
}

export async function getRun(db, monitorId, id) {
  const rows = await db.all('SELECT * FROM runs WHERE monitor_id = ? AND id = ?', [monitorId, id])
  return (await loadRuns(db, rows))[0]
}

export async function listRuns(db, monitorId, after, limit) {
  const rows = await db.all(
    'SELECT * FROM runs WHERE monitor_id = ? AND id < ? ORDER BY id DESC LIMIT ?',
    [monitorId, after ?? '~', limit + 1],
  )
  return {
    data: await loadRuns(db, rows.slice(0, limit)),
    has_more: rows.length > limit,
  }
}

export function insertRun(db, run) {
  return db.run(
    'INSERT INTO runs (id, monitor_id, trigger_kind, status, created_at, started_at) VALUES (?, ?, ?, ?, ?, ?)',
    [run.id, run.monitor_id, run.trigger, run.status, run.created_at, run.started_at ?? null],
  )
}

// Writes the result of a run. Only works while the run is still 'running', so a run that
// was already timed out can't be overwritten by a late result. Returns false in that case.
export async function finishRun(db, run) {
  const result = await db.run(
    `UPDATE runs SET
       status = ?, candidates = ?, change_count = ?, errors = ?, fetched_urls = ?, total_cost = ?,
       error_code = ?, error_message = ?, finished_at = ?
     WHERE id = ? AND status = 'running'`,
    [
      run.status,
      run.counts.candidates,
      run.changes.length,
      run.counts.errors,
      run.usage.fetched_urls,
      run.usage.cost.total_cost,
      run.error ? run.error.code : null,
      run.error ? run.error.message : null,
      run.finished_at,
      run.id,
    ],
  )
  if (result.changes === 0) return false

  const statements = []
  run.changes.forEach((c, position) => {
    statements.push([
      `INSERT INTO run_changes
        (run_id, position, id, type, url, title, snippet, confidence, published_at, last_updated_at,
         diff_unified, diff_added, diff_removed, diff_truncated, previous_fetched_at, fetched_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        run.id,
        position,
        c.id,
        c.type,
        c.url,
        c.title ?? null,
        c.snippet ?? null,
        c.confidence,
        c.published_at ?? null,
        c.last_updated_at ?? null,
        c.diff ? c.diff.unified : null,
        c.diff ? c.diff.added_lines : null,
        c.diff ? c.diff.removed_lines : null,
        c.diff ? Number(c.diff.truncated) : null,
        c.previous_fetched_at ?? null,
        c.fetched_at ?? null,
      ],
    ])
  })
  run.target_errors.forEach((e, position) => {
    statements.push([
      'INSERT INTO run_target_errors (run_id, position, url, code, status_code, message) VALUES (?, ?, ?, ?, ?, ?)',
      [run.id, position, e.url, e.code, e.status_code ?? null, e.message],
    ])
  })
  if (statements.length > 0) await db.batch(statements)
  return true
}

// the delivery log, newest first
export async function listDeliveryAttempts(db, monitorId, after, limit) {
  const rows = await db.all(
    'SELECT * FROM delivery_attempts WHERE monitor_id = ? AND id < ? ORDER BY id DESC LIMIT ?',
    [monitorId, after ?? '~', limit + 1],
  )
  const data = rows.slice(0, limit).map((row) =>
    dropNulls({
      id: row.id,
      object: 'monitor.delivery_attempt',
      event_id: row.event_id,
      event_type: row.event_type,
      run_id: row.run_id,
      target_host: row.target_host,
      attempt: row.attempt,
      delivered: Boolean(row.delivered),
      status_code: row.status_code,
      error: row.error,
      duration_ms: row.duration_ms,
      at: row.at,
      trace_id: row.trace_id,
    }),
  )
  return { data, has_more: rows.length > limit }
}
