// Background work: the scheduler tick and everything that happens during a run.
import { iso, now, runError } from './util.js'
import { newId, idAt } from './crypto.js'
import { nextRun } from './schedule.js'
import * as store from './store.js'
import { judgeConfigured } from './judge.js'
import { runSearch } from './search-monitor.js'
import { runPages } from './page-monitor.js'
import { emit, autoPause, sendDueDeliveries } from './webhooks.js'

const DAY_MS = 24 * 60 * 60 * 1000
const STALE_AFTER_MS = 15 * 60 * 1000
const KEEP_RUNS_DAYS = 90
const SOURCE_FAILURES_BEFORE_PAUSE = 5

// target type -> async (ctx, monitor, run). Fills in run.counts, run.changes, run.target_errors.
export const detectors = {
  search: runSearch,
  page: runPages,
}

export function newRun(monitorId, trigger, status) {
  const createdAt = now()
  return {
    id: newId('run_'),
    monitor_id: monitorId,
    trigger,
    status,
    created_at: createdAt,
    started_at: status === 'running' ? createdAt : null,
    counts: { candidates: 0, changes: 0, errors: 0 },
    usage: { fetched_urls: 0, cost: { total_cost: 0, currency: 'USD' } },
    changes: [],
    target_errors: [],
  }
}

// One pass over all pending work. Called every minute by a timer, a cron trigger or POST /tick.
// Every job is claimed with a conditional UPDATE first, so overlapping ticks don't double-run.
export async function tick(ctx) {
  await failStaleRuns(ctx)
  await startQueuedRuns(ctx)
  await startDueMonitors(ctx)
  await sendDueDeliveries(ctx)
  await deleteOldRuns(ctx)
}

// if the process died mid-run the monitor would stay "busy" forever
async function failStaleRuns(ctx) {
  const cutoff = iso(Date.now() - STALE_AFTER_MS)
  const stale = await ctx.db.all(
    `SELECT id, monitor_id FROM runs WHERE status = 'running' AND started_at < ?`,
    [cutoff],
  )
  for (const row of stale) {
    const run = { ...newRun(row.monitor_id, null, 'running'), id: row.id }
    await finish(ctx, null, run, 'failed', {
      code: 'timed_out',
      message: 'The run did not finish in time',
    })
  }
}

// manual runs are inserted as 'queued' by the API and picked up here
async function startQueuedRuns(ctx) {
  const queued = await ctx.db.all(`SELECT id, monitor_id FROM runs WHERE status = 'queued' ORDER BY id`)
  for (const row of queued) {
    const claimed = await ctx.db.run(
      `UPDATE runs SET status = 'running', started_at = ? WHERE id = ? AND status = 'queued'`,
      [now(), row.id],
    )
    if (claimed.changes === 0) continue
    await execute(ctx, { ...newRun(row.monitor_id, 'manual', 'running'), id: row.id })
  }
}

async function startDueMonitors(ctx) {
  const due = await store.dueMonitors(ctx.db, now())
  // TODO: runs are executed one after another. Fine for a handful of monitors and easy
  // on LLM rate limits, but will need a small pool if someone has hundreds.
  for (const monitor of due) {
    const next = iso(nextRun(monitor.schedule, Date.now()))
    const moved = await ctx.db.run(
      'UPDATE monitors SET next_run_at = ? WHERE id = ? AND next_run_at = ?',
      [next, monitor.id, monitor.next_run_at],
    )
    if (moved.changes === 0) continue // another tick got it

    const run = newRun(monitor.id, 'schedule', 'running')
    const claimed = await ctx.db.run(
      'UPDATE monitors SET current_run_id = ? WHERE id = ? AND current_run_id IS NULL',
      [run.id, monitor.id],
    )
    if (claimed.changes === 0) continue // previous run still going, skip this slot

    await store.insertRun(ctx.db, run)
    await execute(ctx, run)
  }
}

async function deleteOldRuns(ctx) {
  const cutoff = idAt('run_', Date.now() - KEEP_RUNS_DAYS * DAY_MS)
  await ctx.db.batch([
    ['DELETE FROM run_changes WHERE run_id < ?', [cutoff]],
    ['DELETE FROM run_target_errors WHERE run_id < ?', [cutoff]],
    ['DELETE FROM runs WHERE id < ?', [cutoff]],
  ])
}

// The window is (from, to]. The first one reaches back one schedule period before the
// monitor was created (max 7 days), later ones start where the last good run ended.
function runWindow(monitor, startedMs) {
  if (monitor.window_to) return { from: monitor.window_to, to: iso(startedMs) }
  const first = nextRun(monitor.schedule, startedMs)
  const period = nextRun(monitor.schedule, first) - first
  const lookback = Math.min(period, 7 * DAY_MS)
  return { from: iso(Date.parse(monitor.created_at) - lookback), to: iso(startedMs) }
}

async function execute(ctx, run) {
  const monitor = await store.getMonitor(ctx.db, run.monitor_id)
  if (!monitor) return // deleted while the run was queued

  run.window = runWindow(monitor, Date.now())
  await ctx.db.run('UPDATE runs SET window_from = ?, window_to = ? WHERE id = ?', [
    run.window.from,
    run.window.to,
    run.id,
  ])

  try {
    // without a judge we'd have to report everything or nothing, so don't run at all
    if (!judgeConfigured(ctx.env)) {
      throw runError('judge_failed', 'No LLM is configured: set LLM_API_KEY, LLM_BASE_URL or LLM_COMMAND')
    }
    const type = monitor.targets[0].type
    const detect = detectors[type]
    if (!detect) throw runError('detect_failed', `No detector for "${type}" targets`)
    await detect(ctx, monitor, run)
    await finish(ctx, monitor, run, 'succeeded')
  } catch (e) {
    if (!e.code) console.error(e) // a bug rather than an expected failure
    await finish(ctx, monitor, run, 'failed', {
      code: e.code ?? 'detect_failed',
      message: e.message,
    })
  }
}

function estimateCost(env, monitor, run) {
  // operator-defined rates, both default to 0 since self-hosting has no per-run price
  let cost
  if (monitor.targets[0].type === 'search') {
    cost = Number(env.COST_PER_SEARCH_RUN) || 0
  } else {
    cost = run.usage.fetched_urls * (Number(env.COST_PER_PAGE_FETCH) || 0)
  }
  return Math.round(cost * 100000) / 100000
}

async function finish(ctx, monitor, run, status, error) {
  monitor = monitor ?? (await store.getMonitor(ctx.db, run.monitor_id))
  run.status = status
  run.finished_at = now()
  run.error = error
  if (status === 'succeeded' && monitor) {
    run.usage.cost.total_cost = estimateCost(ctx.env, monitor, run)
  }

  const saved = await store.finishRun(ctx.db, run)
  if (!saved) return // already finished elsewhere, e.g. marked as timed out

  const sourceFailed = error && ['detect_failed', 'source_failed'].includes(error.code)
  const windowTo = status === 'succeeded' && run.window ? run.window.to : null
  await ctx.db.run(
    `UPDATE monitors SET
       current_run_id = NULL,
       last_run_id = ?,
       window_to = COALESCE(?, window_to),
       fail_streak = ${sourceFailed ? 'fail_streak + 1' : '0'}
     WHERE id = ? AND current_run_id = ?`,
    [run.id, windowTo, run.monitor_id, run.id],
  )
  if (!monitor) return

  // events carry the run exactly as GET /runs/{id} returns it
  const view = await store.getRun(ctx.db, run.monitor_id, run.id)
  if (status === 'succeeded' && run.changes.length > 0) {
    await emit(ctx, monitor, 'monitor.changes.detected', view)
  }
  await emit(ctx, monitor, 'monitor.run.completed', view)

  if (sourceFailed && monitor.fail_streak + 1 >= SOURCE_FAILURES_BEFORE_PAUSE) {
    await autoPause(ctx, monitor, 'source_failing', view)
  }
}
