import test from 'node:test'
import assert from 'node:assert/strict'
import { makeApp, fakeServer, searchMonitor } from './helpers.js'
import { createTelemetry } from '../src/telemetry.js'

const RESULTS = [{ title: 'Big round', url: 'https://news.example.com/big-round', content: 'KEEP: $2B for GPUs' }]

function attrs(span) {
  const out = {}
  for (const { key, value } of span.attributes) {
    out[key] = value.stringValue ?? value.boolValue ?? Number(value.intValue ?? value.doubleValue)
  }
  return out
}

async function setup() {
  const collector = await fakeServer(() => ({ status: 200, body: {} }))
  const tavily = await fakeServer(() => ({ body: { results: RESULTS } }))
  const receiver = await fakeServer(() => ({ status: 200 }))
  const app = await makeApp({
    TAVILY_API_KEY: 'k',
    TAVILY_URL: tavily.url,
    OTEL_EXPORTER_OTLP_ENDPOINT: collector.url + '/otlp/',
    OTEL_EXPORTER_OTLP_HEADERS: 'Authorization=Basic%20abc123,x-team=obs',
    OTEL_SERVICE_NAME: 'open-monitor-test',
  })
  const created = await app.call('POST', '/v1/monitors', searchMonitor({ webhook: { url: receiver.url + '/hook/secret-path-token' } }))
  return { ...app, collector, receiver, id: created.body.id, secret: created.body.webhook.secret }
}

function exported(collector, path) {
  return collector.requests.filter((r) => r.url === path).map((r) => r.json)
}

test('a run is exported as one trace, from search to webhook delivery', async () => {
  const app = await setup()
  const run = await app.runAndWait(app.id)
  assert.match(run.trace_id, /^[0-9a-f]{32}$/)

  const spans = exported(app.collector, '/otlp/v1/traces').flatMap((body) => body.resourceSpans[0].scopeSpans[0].spans)
  const inTrace = spans.filter((s) => s.traceId === run.trace_id)
  const names = inTrace.map((s) => s.name).sort()
  assert.deepEqual(names, ['judge.call', 'monitor.run', 'search', 'webhook.delivery'])

  const root = inTrace.find((s) => s.name === 'monitor.run')
  assert.equal(attrs(root)['run.id'], run.id)
  assert.equal(attrs(root)['run.status'], 'succeeded')
  assert.equal(attrs(root)['run.changes'], 1)
  for (const child of ['search', 'judge.call']) {
    assert.equal(inTrace.find((s) => s.name === child).parentSpanId, root.spanId, child)
  }

  const delivery = inTrace.find((s) => s.name === 'webhook.delivery')
  assert.equal(attrs(delivery)['http.status_code'], 200)
  assert.equal(attrs(delivery)['webhook.attempt'], 1)

  // the receiver gets the trace context, so it can continue the same trace
  const header = app.receiver.requests[0].headers.traceparent
  assert.equal(header, `00-${run.trace_id}-${delivery.spanId}-01`)

  // collector auth headers and service name
  const first = app.collector.requests[0]
  assert.equal(first.headers.authorization, 'Basic abc123')
  assert.equal(first.headers['x-team'], 'obs')
  const resource = exported(app.collector, '/otlp/v1/traces')[0].resourceSpans[0].resource
  assert.deepEqual(resource.attributes, [{ key: 'service.name', value: { stringValue: 'open-monitor-test' } }])
})

test('secrets and url paths never reach the collector', async () => {
  const app = await setup()
  await app.runAndWait(app.id)
  const everything = app.collector.requests.map((r) => r.raw).join('\n')

  assert.equal(everything.includes('secret-path-token'), false, 'webhook path leaked')
  assert.equal(everything.includes(app.secret), false, 'signing secret leaked')
  assert.equal(everything.includes('test-key'), false, 'api key leaked')
  assert.equal(everything.includes('KEEP: $2B'), false, 'page content leaked')
  assert.ok(everything.includes('127.0.0.1'), 'the webhook host should be there')
})

test('counters and failure logs are exported', async () => {
  const collector = await fakeServer(() => ({ status: 200, body: {} }))
  const broken = await fakeServer(() => ({ status: 503, body: 'down' }))
  const app = await makeApp({ TAVILY_API_KEY: 'k', TAVILY_URL: broken.url, OTEL_EXPORTER_OTLP_ENDPOINT: collector.url })
  const id = (await app.call('POST', '/v1/monitors', searchMonitor())).body.id
  const run = await app.runAndWait(id)
  assert.equal(run.status, 'failed')

  const metrics = exported(collector, '/v1/metrics').at(-1).resourceMetrics[0].scopeMetrics[0].metrics
  const runs = metrics.find((m) => m.name === 'open_monitor.runs')
  assert.equal(runs.sum.isMonotonic, true)
  assert.equal(Number(runs.sum.dataPoints[0].asInt), 1) // OTLP JSON allows a number or a string here
  assert.deepEqual(attrs(runs.sum.dataPoints[0]), { status: 'failed', trigger: 'manual' })

  const logs = exported(collector, '/v1/logs').flatMap((body) => body.resourceLogs[0].scopeLogs[0].logRecords)
  const failure = logs.find((l) => l.body.stringValue.startsWith('run failed'))
  assert.equal(failure.severityText, 'ERROR')
  assert.equal(failure.traceId, run.trace_id)
  assert.equal(attrs(failure)['error.code'], 'detect_failed')
})

test('the delivery log lists every attempt', async () => {
  let calls = 0
  const tavily = await fakeServer(() => ({ body: { results: RESULTS } }))
  const receiver = await fakeServer(() => ({ status: ++calls === 1 ? 500 : 200 }))
  const app = await makeApp({ TAVILY_API_KEY: 'k', TAVILY_URL: tavily.url })
  const id = (await app.call('POST', '/v1/monitors', searchMonitor({ webhook: { url: receiver.url + '/hook' } }))).body.id

  const run = await app.runAndWait(id)
  await app.ctx.db.run(`UPDATE deliveries SET next_at = '2026-01-01T00:00:00Z'`)
  await app.call('POST', '/tick')

  const log = (await app.call('GET', `/v1/monitors/${id}/deliveries`)).body
  assert.equal(log.object, 'list')
  assert.equal(log.data.length, 2)
  const [second, first] = log.data // newest first
  assert.equal(first.attempt, 1)
  assert.equal(first.delivered, false)
  assert.equal(first.status_code, 500)
  assert.equal(first.error, 'http_status')
  assert.equal(second.attempt, 2)
  assert.equal(second.delivered, true)
  assert.equal(second.event_type, 'monitor.changes.detected')
  assert.equal(second.run_id, run.id)
  assert.equal(second.trace_id, run.trace_id)
  assert.equal(second.target_host, new URL(receiver.url).host)
  assert.equal(second.event_id, first.event_id)
})

test('nothing is sent and nothing breaks without an endpoint or with a dead collector', async () => {
  const off = createTelemetry({})
  assert.equal(off.enabled, false)
  const span = off.startSpan('x')
  assert.match(span.traceId, /^[0-9a-f]{32}$/) // ids exist even when export is off
  span.end()
  await off.flush()

  const dead = await makeApp({ TAVILY_API_KEY: 'k', OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:1' })
  const id = (await dead.call('POST', '/v1/monitors', searchMonitor())).body.id
  const run = await dead.runAndWait(id)
  assert.ok(run.status) // the run still completes
})
