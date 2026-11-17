// OpenTelemetry export without the SDK. Spans, counters and log records are buffered in
// memory and sent as OTLP/HTTP JSON when OTEL_EXPORTER_OTLP_ENDPOINT is set.
// Works with any OTLP backend (Grafana Cloud, Honeycomb, New Relic, a local collector...).
//
// Trace ids are generated even when export is off, so runs and deliveries always carry one.

const startedAt = Date.now()

function randomHex(bytes) {
  const buffer = crypto.getRandomValues(new Uint8Array(bytes))
  return [...buffer].map((b) => b.toString(16).padStart(2, '0')).join('')
}

function nanos(ms) {
  return String(BigInt(Math.round(ms)) * 1_000_000n)
}

// { a: 1, b: 'x' } -> OTLP attribute list. null/undefined values are dropped.
function attributes(obj = {}) {
  const list = []
  for (const [key, value] of Object.entries(obj)) {
    if (value === null || value === undefined) continue
    if (typeof value === 'boolean') list.push({ key, value: { boolValue: value } })
    else if (Number.isInteger(value)) list.push({ key, value: { intValue: String(value) } })
    else if (typeof value === 'number') list.push({ key, value: { doubleValue: value } })
    else list.push({ key, value: { stringValue: String(value) } })
  }
  return list
}

// "key=value,other=value" as used by the standard OTEL_EXPORTER_OTLP_HEADERS variable
function parseHeaders(raw = '') {
  const headers = {}
  for (const pair of raw.split(',')) {
    const index = pair.indexOf('=')
    if (index > 0) headers[pair.slice(0, index).trim()] = decodeURIComponent(pair.slice(index + 1).trim())
  }
  return headers
}

export function createTelemetry(env) {
  const endpoint = env.OTEL_EXPORTER_OTLP_ENDPOINT?.replace(/\/+$/, '')
  const enabled = Boolean(endpoint)
  const resource = {
    attributes: attributes({ 'service.name': env.OTEL_SERVICE_NAME ?? 'open-monitor' }),
  }
  const scope = { name: 'open-monitor' }

  let spans = []
  let logs = []
  const counters = new Map() // "name|attrs json" -> { name, attrs, value }
  let warned = false

  // parent is { traceId, spanId } or nothing for a new trace
  function startSpan(name, attrs = {}, parent) {
    const span = {
      traceId: parent?.traceId ?? randomHex(16),
      spanId: randomHex(8),
      parentSpanId: parent?.spanId,
      name,
      start: Date.now(),
      attrs: { ...attrs },
    }
    span.end = (moreAttrs = {}, error) => {
      if (!enabled) return
      spans.push({
        traceId: span.traceId,
        spanId: span.spanId,
        parentSpanId: span.parentSpanId,
        name,
        kind: 1,
        startTimeUnixNano: nanos(span.start),
        endTimeUnixNano: nanos(Date.now()),
        attributes: attributes({ ...span.attrs, ...moreAttrs }),
        status: error ? { code: 2, message: String(error) } : { code: 1 },
      })
    }
    return span
  }

  function count(name, attrs = {}, by = 1) {
    if (!enabled) return
    const key = name + '|' + JSON.stringify(attrs)
    const counter = counters.get(key) ?? { name, attrs, value: 0 }
    counter.value += by
    counters.set(key, counter)
  }

  // severity: 'INFO' | 'WARN' | 'ERROR'
  function log(severity, message, attrs = {}, trace) {
    if (!enabled) return
    const numbers = { INFO: 9, WARN: 13, ERROR: 17 }
    logs.push({
      timeUnixNano: nanos(Date.now()),
      severityText: severity,
      severityNumber: numbers[severity] ?? 9,
      body: { stringValue: message },
      attributes: attributes(attrs),
      traceId: trace?.traceId,
      spanId: trace?.spanId,
    })
  }

  async function send(path, body) {
    const res = await fetch(endpoint + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...parseHeaders(env.OTEL_EXPORTER_OTLP_HEADERS) },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    })
    await res.body?.cancel()
    if (!res.ok) throw new Error(`collector answered ${res.status} on ${path}`)
  }

  // Sends whatever is buffered. Telemetry must never break the app, so failures are only logged.
  async function flush() {
    if (!enabled) return
    const batch = { spans, logs }
    spans = []
    logs = []
    try {
      if (batch.spans.length) {
        await send('/v1/traces', { resourceSpans: [{ resource, scopeSpans: [{ scope, spans: batch.spans }] }] })
      }
      if (batch.logs.length) {
        await send('/v1/logs', { resourceLogs: [{ resource, scopeLogs: [{ scope, logRecords: batch.logs }] }] })
      }
      if (counters.size) {
        // cumulative sums since the process started
        const metrics = [...counters.values()].map((c) => ({
          name: c.name,
          sum: {
            aggregationTemporality: 2,
            isMonotonic: true,
            dataPoints: [
              {
                attributes: attributes(c.attrs),
                startTimeUnixNano: nanos(startedAt),
                timeUnixNano: nanos(Date.now()),
                asInt: String(c.value),
              },
            ],
          },
        }))
        await send('/v1/metrics', { resourceMetrics: [{ resource, scopeMetrics: [{ scope, metrics }] }] })
      }
    } catch (e) {
      if (!warned) console.warn(`telemetry export failed: ${e.message}`)
      warned = true
    }
  }

  return { enabled, startSpan, count, log, flush }
}

// W3C trace context header, so a receiver that uses OpenTelemetry can join our trace
export function traceparent(span) {
  return `00-${span.traceId}-${span.spanId}-01`
}

// Only the host goes into telemetry. Webhook urls often carry a token in the path.
export function hostOf(url) {
  try {
    return new URL(url).host
  } catch {
    return 'invalid'
  }
}
