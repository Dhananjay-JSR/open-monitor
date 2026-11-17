import test from 'node:test'
import assert from 'node:assert/strict'
import { openDb } from '../src/db-node.js'
import * as store from '../src/store.js'

function sampleMonitor(overrides = {}) {
  return {
    id: 'mon_1',
    name: 'AI funding',
    goal: 'new rounds',
    targets: [
      {
        type: 'search',
        query: 'ai funding',
        max_results: 5,
        filters: {
          freshness: ['published', 'updated'],
          include_domains: ['a.com', 'b.com'],
          exclude_domains: ['c.com'],
        },
        judge: { threshold: 0.7 },
      },
    ],
    schedule: { type: 'cron', cron: '0 9 * * *', timezone: 'UTC' },
    webhook: { url: 'https://hook.example/x', events: ['monitor.changes.detected', 'monitor.paused'] },
    metadata: { team: 'growth', tier: 'gold' },
    status: 'active',
    next_run_at: '2026-11-18T09:00:00Z',
    secret: 'whsec_x',
    created_at: '2026-11-17T00:00:00Z',
    updated_at: '2026-11-17T00:00:00Z',
    ...overrides,
  }
}

async function freshDb() {
  const db = openDb(':memory:')
  await store.migrate(db)
  return db
}

async function count(db, table) {
  const rows = await db.all(`SELECT count(*) AS n FROM ${table}`)
  return rows[0].n
}

test('migrate can run twice', async () => {
  const db = await freshDb()
  await store.migrate(db)
})

test('monitor round trip', async () => {
  const db = await freshDb()
  const m = sampleMonitor()
  await store.insertMonitor(db, m, 'key-1')

  const loaded = await store.getMonitor(db, 'mon_1')
  for (const field of ['name', 'goal', 'targets', 'schedule', 'webhook', 'metadata', 'status', 'next_run_at', 'secret']) {
    assert.deepEqual(loaded[field], m[field], field)
  }
  assert.equal((await store.getMonitorByIdemKey(db, 'key-1')).id, 'mon_1')
  assert.equal(await store.getMonitor(db, 'mon_missing'), undefined)
})

test('update rewrites children and checks the version', async () => {
  const db = await freshDb()
  const pages = [
    { type: 'page', url: 'https://a.example/' },
    { type: 'page', url: 'https://b.example/' },
  ]
  await store.insertMonitor(db, sampleMonitor({ targets: pages }))
  await db.run(`INSERT INTO page_baselines VALUES ('mon_1', 'https://b.example/', 'old', '2026-11-17T00:00:00Z')`)

  const m = await store.getMonitor(db, 'mon_1')
  const stale = { ...m }
  m.targets = [pages[0]]
  m.metadata = {}
  m.webhook = null
  assert.equal(await store.updateMonitor(db, m, ['https://b.example/']), true)

  const loaded = await store.getMonitor(db, 'mon_1')
  assert.deepEqual(loaded.targets, [pages[0]])
  assert.deepEqual(loaded.metadata, {})
  assert.equal(loaded.webhook, null)
  assert.equal(loaded.version, 1)
  assert.equal(await count(db, 'page_baselines'), 0)

  // second writer still has version 0
  assert.equal(await store.updateMonitor(db, stale), false)
})

test('list is newest first with a cursor', async () => {
  const db = await freshDb()
  for (const id of ['mon_a', 'mon_b', 'mon_c']) {
    await store.insertMonitor(db, sampleMonitor({ id, webhook: null }))
  }
  const first = await store.listMonitors(db, null, 2)
  assert.deepEqual(first.data.map((m) => m.id), ['mon_c', 'mon_b'])
  assert.equal(first.has_more, true)

  const second = await store.listMonitors(db, 'mon_b', 2)
  assert.deepEqual(second.data.map((m) => m.id), ['mon_a'])
  assert.equal(second.has_more, false)
})

test('run results are stored once and deleted with the monitor', async () => {
  const db = await freshDb()
  await store.insertMonitor(db, sampleMonitor())

  const run = {
    id: 'run_1',
    monitor_id: 'mon_1',
    trigger: 'manual',
    status: 'running',
    created_at: '2026-11-17T00:00:00Z',
    started_at: '2026-11-17T00:00:01Z',
    counts: { candidates: 2, changes: 0, errors: 1 },
    usage: { fetched_urls: 1, cost: { total_cost: 0.001, currency: 'USD' } },
    changes: [
      {
        id: 'chg_1',
        type: 'page_change',
        url: 'https://a.example/',
        confidence: 0.9,
        diff: { unified: '@@', added_lines: 1, removed_lines: 0, truncated: false },
        previous_fetched_at: '2026-11-16T00:00:00Z',
        fetched_at: '2026-11-17T00:00:00Z',
      },
    ],
    target_errors: [
      { type: 'page', url: 'https://b.example/', code: 'http_status', status_code: 503, message: 'HTTP 503' },
    ],
  }
  await store.insertRun(db, run)
  assert.deepEqual((await store.getRun(db, 'mon_1', 'run_1')).changes, [])

  run.status = 'succeeded'
  run.finished_at = '2026-11-17T00:00:05Z'
  assert.equal(await store.finishRun(db, run), true)
  assert.equal(await store.finishRun(db, { ...run, status: 'failed' }), false)

  const loaded = await store.getRun(db, 'mon_1', 'run_1')
  assert.equal(loaded.status, 'succeeded')
  assert.deepEqual(loaded.changes, run.changes)
  assert.deepEqual(loaded.target_errors, run.target_errors)
  assert.deepEqual(loaded.counts, { candidates: 2, changes: 1, errors: 1 })
  assert.equal('window' in loaded, false)

  await store.deleteMonitor(db, 'mon_1')
  for (const table of ['monitors', 'monitor_targets', 'monitor_domains', 'monitor_metadata', 'runs', 'run_changes', 'run_target_errors']) {
    assert.equal(await count(db, table), 0, table)
  }
})
