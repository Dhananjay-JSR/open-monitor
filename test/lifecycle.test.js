import test from 'node:test'
import assert from 'node:assert/strict'
import { makeApp, searchMonitor } from './helpers.js'
import { detectors } from '../src/runner.js'

// swap in a fake search detector so these tests only cover the run lifecycle
function stubDetector(fn) {
  const original = detectors.search
  detectors.search = fn
  return () => {
    detectors.search = original
  }
}

async function createMonitor(call, overrides) {
  return (await call('POST', '/v1/monitors', searchMonitor(overrides))).body.id
}

test('manual run goes queued -> succeeded', async () => {
  const { call, settle } = await makeApp()

  // hold the run open until we've looked at the in-flight state
  let release
  const gate = new Promise((resolve) => (release = resolve))
  const restore = stubDetector(async (ctx, monitor, run) => {
    await gate
    run.counts.candidates = 3
    run.changes.push({ id: 'chg_1', type: 'search_result', url: 'https://a.example/', confidence: 0.8 })
  })

  const id = await createMonitor(call)
  const queued = await call('POST', `/v1/monitors/${id}/run`)
  assert.equal(queued.status, 202)
  assert.equal(queued.body.status, 'queued')
  assert.equal(queued.body.trigger, 'manual')
  assert.equal(queued.body.object, 'monitor.run')
  assert.equal('window' in queued.body, false)
  assert.equal((await call('GET', `/v1/monitors/${id}`)).body.current_run_id, queued.body.id)

  const again = await call('POST', `/v1/monitors/${id}/run`)
  assert.equal(again.status, 409)
  assert.equal(again.body.error.type, 'run_in_progress')
  assert.equal(again.body.error.current_run_id, queued.body.id)

  release()
  await settle()

  const run = (await call('GET', `/v1/monitors/${id}/runs/${queued.body.id}`)).body
  assert.equal(run.status, 'succeeded')
  assert.deepEqual(run.counts, { candidates: 3, changes: 1, errors: 0 })
  assert.equal(run.changes.length, 1)
  assert.ok(run.window.from < run.window.to)
  assert.ok(run.finished_at)

  const monitor = (await call('GET', `/v1/monitors/${id}`)).body
  assert.equal('current_run_id' in monitor, false)
  assert.deepEqual(monitor.last_run, {
    id: run.id,
    status: 'succeeded',
    change_count: 1,
    finished_at: run.finished_at,
  })

  assert.equal((await call('GET', `/v1/monitors/${id}/runs`)).body.data.length, 1)
  assert.equal((await call('GET', `/v1/monitors/${id}/runs/run_missing`)).status, 404)
  restore()
})

test('next window starts where the previous one ended', async () => {
  const { call, settle } = await makeApp()
  const restore = stubDetector(async () => {})
  const id = await createMonitor(call)

  const first = (await call('POST', `/v1/monitors/${id}/run`)).body.id
  await settle()
  const second = (await call('POST', `/v1/monitors/${id}/run`)).body.id
  await settle()

  const a = (await call('GET', `/v1/monitors/${id}/runs/${first}`)).body
  const b = (await call('GET', `/v1/monitors/${id}/runs/${second}`)).body
  assert.equal(b.window.from, a.window.to)
  restore()
})

test('detector errors fail the run', async () => {
  const { call, settle } = await makeApp()
  const restore = stubDetector(async () => {
    const e = new Error('search is down')
    e.code = 'detect_failed'
    throw e
  })
  const id = await createMonitor(call)
  const runId = (await call('POST', `/v1/monitors/${id}/run`)).body.id
  await settle()

  const run = (await call('GET', `/v1/monitors/${id}/runs/${runId}`)).body
  assert.equal(run.status, 'failed')
  assert.deepEqual(run.error, { code: 'detect_failed', message: 'search is down' })
  assert.equal((await call('GET', `/v1/monitors/${id}`)).body.last_run.status, 'failed')
  restore()
})

test('pause and resume', async () => {
  const { call } = await makeApp()
  const id = await createMonitor(call)

  const paused = (await call('POST', `/v1/monitors/${id}/pause`)).body
  assert.equal(paused.status, 'paused')
  assert.equal(paused.pause_reason, 'user')
  assert.equal('next_run_at' in paused, false)

  assert.equal((await call('POST', `/v1/monitors/${id}/pause`)).body.error.type, 'invalid_state')
  assert.equal((await call('POST', `/v1/monitors/${id}/run`)).status, 409)

  const resumed = (await call('POST', `/v1/monitors/${id}/resume`)).body
  assert.equal(resumed.status, 'active')
  assert.equal('pause_reason' in resumed, false)
  assert.ok(resumed.next_run_at)
  assert.equal((await call('POST', `/v1/monitors/${id}/resume`)).status, 409)
})

test('pausing skips a queued run', async () => {
  const { call, ctx } = await makeApp()
  const id = await createMonitor(call)

  // queue a run by hand, as if the tick hadn't picked it up yet
  await ctx.db.run(
    `INSERT INTO runs (id, monitor_id, trigger_kind, status, created_at)
     VALUES ('run_q', ?, 'manual', 'queued', '2026-11-17T00:00:00Z')`,
    [id],
  )

  await call('POST', `/v1/monitors/${id}/pause`)
  const run = (await call('GET', `/v1/monitors/${id}/runs/run_q`)).body
  assert.equal(run.status, 'skipped')
  assert.equal(run.error.skip_reason, 'user')
  assert.equal('current_run_id' in (await call('GET', `/v1/monitors/${id}`)).body, false)
})

test('tick runs monitors that are due', async () => {
  const { call, ctx } = await makeApp()
  const restore = stubDetector(async () => {})
  const id = await createMonitor(call, { schedule: { type: 'interval', interval: '1h' } })

  assert.equal((await call('POST', '/tick')).status, 200)
  assert.equal((await call('GET', `/v1/monitors/${id}/runs`)).body.data.length, 0)

  await ctx.db.run(`UPDATE monitors SET next_run_at = '2026-01-01T00:00:00Z' WHERE id = ?`, [id])
  await call('POST', '/tick')

  const runs = (await call('GET', `/v1/monitors/${id}/runs`)).body.data
  assert.equal(runs.length, 1)
  assert.equal(runs[0].trigger, 'schedule')
  assert.equal(runs[0].status, 'succeeded')
  assert.ok((await call('GET', `/v1/monitors/${id}`)).body.next_run_at > new Date().toISOString())
  restore()
})

test('tick fails runs that have been stuck for too long', async () => {
  const { call, ctx } = await makeApp()
  const id = await createMonitor(call)
  await ctx.db.run(
    `INSERT INTO runs (id, monitor_id, trigger_kind, status, created_at, started_at)
     VALUES ('run_stuck', ?, 'schedule', 'running', '2026-11-17T00:00:00Z', '2026-11-17T00:00:00Z')`,
    [id],
  )

  await call('POST', '/tick')
  const run = (await call('GET', `/v1/monitors/${id}/runs/run_stuck`)).body
  assert.equal(run.status, 'failed')
  assert.equal(run.error.code, 'timed_out')
  assert.equal('current_run_id' in (await call('GET', `/v1/monitors/${id}`)).body, false)
})

test('a monitor whose last run is still going runs late, not skipped', async () => {
  const { call, ctx } = await makeApp()
  const restore = stubDetector(async () => {})
  const id = await createMonitor(call)

  // an earlier run is still going when the monitor comes due
  await ctx.db.run(
    `INSERT INTO runs (id, monitor_id, trigger_kind, status, created_at, started_at)
     VALUES ('run_busy', ?, 'manual', 'running', '2026-11-17T00:00:00Z', ?)`,
    [id, new Date().toISOString()],
  )
  await ctx.db.run(`UPDATE monitors SET next_run_at = '2026-01-01T00:00:00Z' WHERE id = ?`, [id])

  await call('POST', '/tick')
  let monitor = (await call('GET', `/v1/monitors/${id}`)).body
  assert.equal((await call('GET', `/v1/monitors/${id}/runs`)).body.data.length, 1) // only the busy one
  assert.equal(monitor.next_run_at, '2026-01-01T00:00:00Z') // still due, the slot was not thrown away

  // the busy run ends: the very next tick runs the waiting slot
  await ctx.db.run(`UPDATE runs SET status = 'succeeded' WHERE id = 'run_busy'`)
  await call('POST', '/tick')
  const runs = (await call('GET', `/v1/monitors/${id}/runs`)).body.data
  assert.equal(runs.length, 2)
  assert.ok(runs.some((r) => r.trigger === 'schedule' && r.status === 'succeeded'))
  monitor = (await call('GET', `/v1/monitors/${id}`)).body
  assert.ok(monitor.next_run_at > new Date().toISOString())
  restore()
})

test('two ticks at once share the due monitors and never run one twice', async () => {
  const { call, ctx } = await makeApp()
  const restore = stubDetector(async () => new Promise((resolve) => setTimeout(resolve, 50)))
  const ids = []
  for (const name of ['a', 'b', 'c']) ids.push(await createMonitor(call, { name }))
  await ctx.db.run(`UPDATE monitors SET next_run_at = '2026-01-01T00:00:00Z'`)

  await Promise.all([call('POST', '/tick'), call('POST', '/tick')])

  for (const id of ids) {
    const runs = (await call('GET', `/v1/monitors/${id}/runs`)).body.data
    assert.equal(runs.length, 1, id)
    assert.equal(runs[0].status, 'succeeded')
  }
  restore()
})

test('a monitor that comes due while a tick is busy is run by the same tick', async () => {
  const { call, ctx } = await makeApp()
  const first = await createMonitor(call, { name: 'first' })
  const second = await createMonitor(call, { name: 'second' })
  await ctx.db.run(`UPDATE monitors SET next_run_at = '2026-01-01T00:00:00Z' WHERE id = ?`, [first])

  // while the first monitor runs, the second one becomes due
  const restore = stubDetector(async (_ctx, monitor) => {
    if (monitor.id === first) {
      await ctx.db.run(`UPDATE monitors SET next_run_at = '2026-01-01T00:00:00Z' WHERE id = ?`, [second])
    }
  })
  await call('POST', '/tick')

  assert.equal((await call('GET', `/v1/monitors/${first}/runs`)).body.data.length, 1)
  assert.equal((await call('GET', `/v1/monitors/${second}/runs`)).body.data.length, 1)
  restore()
})

test('the tick clears llm_calls rows older than a minute', async () => {
  const { call, ctx } = await makeApp()
  await ctx.db.run('INSERT INTO llm_calls (id, at) VALUES (?, ?)', ['llm_old', new Date(Date.now() - 120_000).toISOString()])
  await ctx.db.run('INSERT INTO llm_calls (id, at) VALUES (?, ?)', ['llm_new', new Date().toISOString()])
  await call('POST', '/tick')
  const rows = await ctx.db.all('SELECT id FROM llm_calls')
  assert.deepEqual(rows.map((r) => r.id), ['llm_new'])
})

test('the database refuses a second active run for the same monitor', async () => {
  const { call, ctx } = await makeApp()
  const id = await createMonitor(call)
  const insert = (runId, status) =>
    ctx.db.run(
      `INSERT INTO runs (id, monitor_id, trigger_kind, status, created_at) VALUES (?, ?, 'manual', ?, '2026-11-17T00:00:00Z')`,
      [runId, id, status],
    )
  await insert('run_one', 'running')
  await assert.rejects(insert('run_two', 'queued'), /UNIQUE/)
  await assert.rejects(insert('run_three', 'running'), /UNIQUE/)
  // finished runs don't count, any number of them is fine
  await insert('run_old1', 'succeeded')
  await insert('run_old2', 'failed')
  assert.equal((await call('GET', `/v1/monitors/${id}`)).body.current_run_id, 'run_one')
})

test('a crash right after taking a monitor leaves nothing stuck', async () => {
  const { call, ctx } = await makeApp()
  const restore = stubDetector(async () => {})
  const id = await createMonitor(call)
  await ctx.db.run(`UPDATE monitors SET next_run_at = '2026-01-01T00:00:00Z' WHERE id = ?`, [id])

  // take the monitor the way a tick does, then "crash" before running it
  const { claimNextDue } = await import('../src/store.js')
  const { newRun } = await import('../src/runner.js')
  const taken = await claimNextDue(ctx.db, { ...newRun(null, 'schedule', 'running'), id: 'run_crashed' })
  assert.equal(taken.id, id)

  // the monitor and its run row agree: there is no half-done state to get stuck in
  assert.equal((await call('GET', `/v1/monitors/${id}`)).body.current_run_id, 'run_crashed')
  const crashed = (await call('GET', `/v1/monitors/${id}/runs/run_crashed`)).body
  assert.equal(crashed.status, 'running')

  // 15 minutes later the stuck-run check fails it, and the monitor is free again
  await ctx.db.run(`UPDATE runs SET started_at = '2026-01-01T00:00:00Z' WHERE id = 'run_crashed'`)
  await ctx.db.run(`UPDATE monitors SET next_run_at = '2026-01-01T00:00:00Z' WHERE id = ?`, [id])
  await call('POST', '/tick')
  assert.equal((await call('GET', `/v1/monitors/${id}/runs/run_crashed`)).body.error.code, 'timed_out')
  const runs = (await call('GET', `/v1/monitors/${id}/runs`)).body.data
  assert.ok(runs.some((r) => r.id !== 'run_crashed' && r.status === 'succeeded'), 'the monitor ran again')
  assert.equal('current_run_id' in (await call('GET', `/v1/monitors/${id}`)).body, false)
  restore()
})
