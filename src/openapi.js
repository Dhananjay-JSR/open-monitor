// The OpenAPI 3.1 description of the HTTP API, served at /openapi.json without login.
// Written by hand next to the routes in app.js and the rules in validate.js; test/openapi.test.js
// checks that every route the server answers is in here.
import { EVENT_TYPES } from './validate.js'

const ref = (name) => ({ $ref: `#/components/schemas/${name}` })
const id = (prefix) => ({ type: 'string', pattern: `^${prefix}_` })
const time = { type: 'string', format: 'date-time' }

const json = (schema, description = 'OK') => ({ description, content: { 'application/json': { schema } } })
const list = (item) => ({ type: 'object', required: ['object', 'data', 'has_more'], properties: { object: { const: 'list' }, data: { type: 'array', items: item }, has_more: { type: 'boolean' } } })
const errors = { 400: { $ref: '#/components/responses/Error' }, 401: { $ref: '#/components/responses/Error' }, 404: { $ref: '#/components/responses/Error' } }

const monitorId = { name: 'id', in: 'path', required: true, schema: id('mon') }
const paging = [
  { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 100, default: 20 } },
  { name: 'after', in: 'query', description: 'Id of the last item on the previous page.', schema: { type: 'string' } },
]

const judge = { type: 'object', additionalProperties: false, properties: { threshold: { type: 'number', exclusiveMinimum: 0, maximum: 1, default: 0.5, description: 'Minimum score from the judge for a finding to be kept.' } } }

const schemas = {
  SearchTarget: {
    type: 'object',
    additionalProperties: false,
    required: ['type', 'query'],
    properties: {
      type: { const: 'search' },
      query: { type: 'string', minLength: 1, maxLength: 1000 },
      max_results: { type: 'integer', minimum: 1, maximum: 20, default: 20 },
      filters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          freshness: { type: 'array', items: { enum: ['published', 'updated'] }, description: 'Empty means both.' },
          include_domains: { type: 'array', maxItems: 20, items: { type: 'string', examples: ['example.com'] } },
          exclude_domains: { type: 'array', maxItems: 20, items: { type: 'string' } },
        },
      },
      judge,
    },
  },
  PageTarget: {
    type: 'object',
    additionalProperties: false,
    required: ['type', 'url'],
    properties: { type: { const: 'page' }, url: { type: 'string', format: 'uri', maxLength: 2048, description: 'A public http(s) URL.' }, judge },
  },
  Schedule: {
    oneOf: [
      { type: 'object', additionalProperties: false, required: ['type', 'interval'], properties: { type: { const: 'interval' }, interval: { type: 'string', examples: ['15m', '6h', '1d', '1w'] } } },
      { type: 'object', additionalProperties: false, required: ['type', 'cron'], properties: { type: { const: 'cron' }, cron: { type: 'string', maxLength: 128, examples: ['0 9 * * 1-5'] }, timezone: { type: 'string', default: 'UTC' } } },
    ],
  },
  WebhookInput: {
    type: 'object',
    additionalProperties: false,
    required: ['url'],
    properties: {
      url: { type: 'string', format: 'uri', maxLength: 2048 },
      events: { type: 'array', items: { enum: EVENT_TYPES }, description: 'Defaults to monitor.changes.detected and monitor.paused.' },
      secret: { type: 'string', pattern: '^whsec_', description: 'Signing secret. Generated and returned once when left out.' },
    },
  },
  MonitorInput: {
    type: 'object',
    additionalProperties: false,
    properties: {
      name: { type: 'string', minLength: 1, maxLength: 256 },
      goal: { type: 'string', maxLength: 2000, description: 'What counts as a finding. The judge scores every candidate against it.' },
      targets: { type: 'array', minItems: 1, maxItems: 10, description: 'One search target, or 1 to 10 page targets.', items: { oneOf: [ref('SearchTarget'), ref('PageTarget')] } },
      schedule: ref('Schedule'),
      webhook: { oneOf: [ref('WebhookInput'), { type: 'null' }] },
      metadata: { type: 'object', maxProperties: 16, additionalProperties: { type: 'string', maxLength: 512 } },
    },
  },
  Monitor: {
    type: 'object',
    required: ['id', 'object', 'name', 'targets', 'schedule', 'status', 'created_at', 'updated_at'],
    properties: {
      id: id('mon'),
      object: { const: 'monitor' },
      name: { type: 'string' },
      goal: { type: 'string' },
      targets: { type: 'array', items: { oneOf: [ref('SearchTarget'), ref('PageTarget')] } },
      schedule: ref('Schedule'),
      webhook: { type: 'object', properties: { url: { type: 'string' }, events: { type: 'array', items: { enum: EVENT_TYPES } }, secret: { type: 'string', description: 'Only in the response that created it.' } } },
      metadata: { type: 'object', additionalProperties: { type: 'string' } },
      status: { enum: ['active', 'paused'] },
      pause_reason: { type: 'string' },
      current_run_id: id('run'),
      next_run_at: time,
      last_run: { type: 'object', properties: { id: id('run'), status: { type: 'string' }, change_count: { type: 'integer' }, finished_at: time } },
      created_at: time,
      updated_at: time,
    },
  },
  Change: {
    type: 'object',
    required: ['id', 'type', 'url', 'confidence'],
    properties: {
      id: id('chg'),
      type: { enum: ['search_result', 'page_change'] },
      url: { type: 'string' },
      title: { type: 'string' },
      snippet: { type: 'string' },
      confidence: { type: 'number', minimum: 0, maximum: 1 },
      published_at: time,
      last_updated_at: time,
      diff: { type: 'object', properties: { unified: { type: 'string' }, added_lines: { type: 'integer' }, removed_lines: { type: 'integer' }, truncated: { type: 'boolean' } } },
      previous_fetched_at: time,
      fetched_at: time,
    },
  },
  Run: {
    type: 'object',
    required: ['id', 'object', 'monitor_id', 'status', 'created_at'],
    properties: {
      id: id('run'),
      object: { const: 'monitor.run' },
      monitor_id: id('mon'),
      trigger: { enum: ['schedule', 'manual'] },
      status: { enum: ['queued', 'running', 'succeeded', 'failed'] },
      window: { type: 'object', properties: { from: time, to: time } },
      counts: { type: 'object', properties: { candidates: { type: 'integer' }, changes: { type: 'integer' }, errors: { type: 'integer' } } },
      usage: { type: 'object' },
      changes: { type: 'array', items: ref('Change') },
      target_errors: { type: 'array', items: { type: 'object' } },
      error: { type: 'object', properties: { code: { type: 'string' }, message: { type: 'string' } } },
      trace_id: { type: 'string' },
      created_at: time,
      started_at: time,
      finished_at: time,
    },
  },
  DeliveryAttempt: {
    type: 'object',
    properties: {
      id: { type: 'string' },
      object: { const: 'monitor.delivery_attempt' },
      event_id: id('evt'),
      event_type: { enum: EVENT_TYPES },
      run_id: id('run'),
      target_host: { type: 'string' },
      attempt: { type: 'integer', minimum: 1, maximum: 7 },
      delivered: { type: 'boolean' },
      status_code: { type: 'integer' },
      error: { type: 'string' },
      duration_ms: { type: 'integer' },
      at: time,
      trace_id: { type: 'string' },
    },
  },
  Event: {
    type: 'object',
    description: 'The body of a webhook delivery.',
    required: ['id', 'object', 'type', 'timestamp', 'data'],
    properties: { id: id('evt'), object: { const: 'event' }, type: { enum: [...EVENT_TYPES, 'monitor.webhook.test'] }, timestamp: time, data: { type: 'object', properties: { monitor: { type: 'object' }, run: ref('Run') } } },
  },
  Error: {
    type: 'object',
    required: ['error'],
    properties: { error: { type: 'object', required: ['message', 'type', 'code'], properties: { message: { type: 'string' }, type: { type: 'string' }, code: { type: 'integer' }, param: { type: 'string' } } } },
  },
}

const monitorPaths = {
  '/v1/monitors': {
    get: { operationId: 'listMonitors', summary: 'List monitors', tags: ['Monitors'], parameters: paging, responses: { 200: json(list(ref('Monitor'))), 401: errors[401] } },
    post: {
      operationId: 'createMonitor',
      summary: 'Create a monitor',
      tags: ['Monitors'],
      parameters: [{ name: 'Idempotency-Key', in: 'header', schema: { type: 'string', maxLength: 200 }, description: 'Repeating a request with the same key and body returns the first result.' }],
      requestBody: { required: true, content: { 'application/json': { schema: { allOf: [ref('MonitorInput'), { required: ['name', 'targets', 'schedule'] }] } } } },
      responses: { 200: json(ref('Monitor'), 'The new monitor. webhook.secret is included this once when the server generated it.'), ...errors },
    },
  },
  '/v1/monitors/{id}': {
    parameters: [monitorId],
    get: { operationId: 'getMonitor', summary: 'Get a monitor', tags: ['Monitors'], responses: { 200: json(ref('Monitor')), ...errors } },
    patch: { operationId: 'updateMonitor', summary: 'Update a monitor', description: 'Send only the fields to change. webhook: null removes the webhook.', tags: ['Monitors'], requestBody: { required: true, content: { 'application/json': { schema: ref('MonitorInput') } } }, responses: { 200: json(ref('Monitor')), ...errors, 409: { $ref: '#/components/responses/Error' } } },
    delete: { operationId: 'deleteMonitor', summary: 'Delete a monitor and its history', tags: ['Monitors'], responses: { 200: json({ type: 'object', properties: { id: id('mon'), object: { const: 'monitor' }, deleted: { const: true } } }), ...errors } },
  },
  '/v1/monitors/{id}/pause': { parameters: [monitorId], post: { operationId: 'pauseMonitor', summary: 'Pause a monitor', tags: ['Monitors'], responses: { 200: json(ref('Monitor')), ...errors, 409: { $ref: '#/components/responses/Error' } } } },
  '/v1/monitors/{id}/resume': { parameters: [monitorId], post: { operationId: 'resumeMonitor', summary: 'Resume a paused monitor', tags: ['Monitors'], responses: { 200: json(ref('Monitor')), ...errors, 409: { $ref: '#/components/responses/Error' } } } },
  '/v1/monitors/{id}/run': { parameters: [monitorId], post: { operationId: 'runMonitor', summary: 'Run a monitor now', description: 'Queues a run and returns it. Poll the run until it succeeds or fails.', tags: ['Runs'], responses: { 202: json(ref('Run'), 'Queued'), ...errors, 409: { $ref: '#/components/responses/Error' }, 429: { $ref: '#/components/responses/Error' } } } },
  '/v1/monitors/{id}/runs': { parameters: [monitorId], get: { operationId: 'listRuns', summary: 'List runs, newest first, with their findings', tags: ['Runs'], parameters: paging, responses: { 200: json(list(ref('Run'))), ...errors } } },
  '/v1/monitors/{id}/runs/{run_id}': { parameters: [monitorId, { name: 'run_id', in: 'path', required: true, schema: id('run') }], get: { operationId: 'getRun', summary: 'Get a run', tags: ['Runs'], responses: { 200: json(ref('Run')), ...errors } } },
  '/v1/monitors/{id}/webhook/test': {
    parameters: [monitorId],
    post: {
      operationId: 'testWebhook',
      summary: 'Send a signed test event to the webhook',
      tags: ['Webhooks'],
      responses: { 200: json({ type: 'object', properties: { object: { const: 'monitor.webhook_test' }, event_id: id('evt'), delivered: { type: 'boolean' }, status_code: { type: 'integer' }, duration_ms: { type: 'integer' }, error: { type: 'string' } } }), ...errors },
    },
  },
  '/v1/monitors/{id}/deliveries': { parameters: [monitorId], get: { operationId: 'listDeliveries', summary: 'Webhook delivery attempts, newest first', tags: ['Webhooks'], parameters: paging, responses: { 200: json(list(ref('DeliveryAttempt'))), ...errors } } },
}

const otherPaths = {
  '/health': { get: { operationId: 'health', summary: 'Liveness check', tags: ['Server'], security: [], responses: { 200: json({ type: 'object', properties: { ok: { const: true } } }) } } },
  '/tick': { post: { operationId: 'tick', summary: 'Run the scheduler once', description: 'For hosts without a long-running process: point an external cron at this.', tags: ['Server'], responses: { 200: json({ type: 'object' }), 401: errors[401] } } },
  '/openapi.json': { get: { operationId: 'openapi', summary: 'This document', tags: ['Server'], security: [], responses: { 200: json({ type: 'object' }) } } },
}

export function openapi(origin) {
  return {
    openapi: '3.1.0',
    info: {
      title: 'Open Monitor',
      version: '0.1.0',
      description:
        'Watch web searches and pages on a schedule. A judge scores every new result against the goal, and kept findings arrive as webhooks signed the Standard Webhooks way (webhook-id, webhook-timestamp, webhook-signature headers).',
      license: { name: 'MIT' },
    },
    servers: [{ url: origin }],
    security: [{ apiKey: [] }],
    tags: [{ name: 'Monitors' }, { name: 'Runs' }, { name: 'Webhooks' }, { name: 'Server' }],
    paths: { ...monitorPaths, ...otherPaths },
    webhooks: {
      monitorEvent: {
        post: {
          summary: 'Sent to the monitor\'s webhook url',
          parameters: [
            { name: 'webhook-id', in: 'header', required: true, schema: id('evt') },
            { name: 'webhook-timestamp', in: 'header', required: true, schema: { type: 'string', description: 'Unix seconds.' } },
            { name: 'webhook-signature', in: 'header', required: true, schema: { type: 'string', description: 'v1,<base64 HMAC-SHA256 of "id.timestamp.body" with the secret after whsec_>. During a secret rotation two signatures are sent, separated by a space.' } },
            { name: 'traceparent', in: 'header', schema: { type: 'string' } },
          ],
          requestBody: { content: { 'application/json': { schema: ref('Event') } } },
          responses: { 200: { description: 'Any 2xx counts as delivered. Anything else is retried after 5s, 5m, 30m, 2h, 5h and 10h.' } },
        },
      },
    },
    components: {
      securitySchemes: { apiKey: { type: 'http', scheme: 'bearer', description: 'The API_KEY set on the server.' } },
      responses: { Error: json(ref('Error'), 'Error') },
      schemas,
    },
  }
}
