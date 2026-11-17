// Telemetry on the official OpenTelemetry packages: traces, counters and logs, sent over
// OTLP/HTTP when OTEL_EXPORTER_OTLP_ENDPOINT is set. Works on Node and on Workers (the
// exporters send with fetch there).
//
// The rest of the code only uses createTelemetry() and the small span object it hands out,
// so swapping the backend never touches callers. Trace ids are generated even when export
// is off, so runs and deliveries always carry one.
import { trace, context, ROOT_CONTEXT, TraceFlags, SeverityNumber, ValueType } from '@opentelemetry/api'
import { TracerProvider, BatchSpanProcessor } from '@opentelemetry/sdk-trace'
import { LoggerProvider, BatchLogRecordProcessor } from '@opentelemetry/sdk-logs'
import { MeterProvider, PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics'
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http'
import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-http'
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http'
import { resourceFromAttributes } from '@opentelemetry/resources'

const SEVERITY = { INFO: SeverityNumber.INFO, WARN: SeverityNumber.WARN, ERROR: SeverityNumber.ERROR }

// "key=value,other=value", the format of the standard OTEL_EXPORTER_OTLP_HEADERS variable
function parseHeaders(raw = '') {
  const headers = {}
  for (const pair of raw.split(',')) {
    const index = pair.indexOf('=')
    if (index > 0) headers[pair.slice(0, index).trim()] = decodeURIComponent(pair.slice(index + 1).trim())
  }
  return headers
}

// OpenTelemetry warns about undefined attribute values, so leave them out
function clean(attrs = {}) {
  const out = {}
  for (const [key, value] of Object.entries(attrs)) {
    if (value !== null && value !== undefined) out[key] = value
  }
  return out
}

// parent can be a span from startSpan, or { traceId, spanId } read back from the database
function parentContext(parent) {
  if (parent?.otelSpan) return trace.setSpan(ROOT_CONTEXT, parent.otelSpan)
  if (parent?.traceId && parent?.spanId) {
    return trace.setSpanContext(ROOT_CONTEXT, {
      traceId: parent.traceId,
      spanId: parent.spanId,
      traceFlags: TraceFlags.SAMPLED,
      isRemote: true,
    })
  }
  return ROOT_CONTEXT
}

export function createTelemetry(env) {
  const endpoint = env.OTEL_EXPORTER_OTLP_ENDPOINT?.replace(/\/+$/, '')
  const enabled = Boolean(endpoint)
  const resource = resourceFromAttributes({ 'service.name': env.OTEL_SERVICE_NAME ?? 'open-monitor' })
  const headers = parseHeaders(env.OTEL_EXPORTER_OTLP_HEADERS)

  // the tracer provider always exists so spans get real ids; it only exports when enabled
  const tracerProvider = new TracerProvider({
    resource,
    spanProcessors: enabled
      ? [new BatchSpanProcessor({ exporter: new OTLPTraceExporter({ url: endpoint + '/v1/traces', headers }) })]
      : [],
  })
  const tracer = tracerProvider.getTracer('open-monitor')

  let loggerProvider = null
  let meterProvider = null
  let logger = null
  let meter = null
  const counters = new Map()
  if (enabled) {
    loggerProvider = new LoggerProvider({
      resource,
      processors: [new BatchLogRecordProcessor({ exporter: new OTLPLogExporter({ url: endpoint + '/v1/logs', headers }) })],
    })
    logger = loggerProvider.getLogger('open-monitor')
    meterProvider = new MeterProvider({
      resource,
      readers: [
        new PeriodicExportingMetricReader({
          exporter: new OTLPMetricExporter({ url: endpoint + '/v1/metrics', headers }),
          exportIntervalMillis: 60_000, // flush() also sends them, at the end of every tick
        }),
      ],
    })
    meter = meterProvider.getMeter('open-monitor')
  }

  function startSpan(name, attrs = {}, parent) {
    const otelSpan = tracer.startSpan(name, { attributes: clean(attrs) }, parentContext(parent))
    const { traceId, spanId } = otelSpan.spanContext()
    return {
      traceId,
      spanId,
      otelSpan,
      end(moreAttrs = {}, error) {
        otelSpan.setAttributes(clean(moreAttrs))
        otelSpan.setStatus(error ? { code: 2, message: String(error) } : { code: 1 })
        otelSpan.end()
      },
    }
  }

  function count(name, attrs = {}, by = 1) {
    if (!meter) return
    if (!counters.has(name)) counters.set(name, meter.createCounter(name, { valueType: ValueType.INT }))
    counters.get(name).add(by, clean(attrs))
  }

  // severity: 'INFO' | 'WARN' | 'ERROR'. `span` ties the record to a trace.
  function log(severity, message, attrs = {}, span) {
    if (!logger) return
    logger.emit({
      severityNumber: SEVERITY[severity] ?? SeverityNumber.INFO,
      severityText: severity,
      body: message,
      attributes: clean(attrs),
      context: span ? parentContext(span) : context.active(),
    })
  }

  let warned = false
  // Sends whatever is buffered. Telemetry must never break the app, so failures are only logged.
  async function flush() {
    if (!enabled) return
    try {
      await Promise.all([tracerProvider.forceFlush(), loggerProvider.forceFlush(), meterProvider.forceFlush()])
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
