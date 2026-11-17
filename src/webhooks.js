// Webhook events: queueing, signed delivery, retries.
// Follows the Standard Webhooks spec so existing verification code keeps working.
import { iso, now } from './util.js'
import { newId, signWebhook } from './crypto.js'
import { getMonitor } from './store.js'

// delay before each retry: 5s, 5m, 30m, 2h, 5h, 10h. Seven attempts in total.
const RETRY_DELAYS_S = [5, 300, 1800, 7200, 18000, 36000]
const USER_AGENT = 'open-monitor/0.1'

// the slice of a monitor that goes into every event, enough to route it without a lookup
function eventMonitor(monitor) {
  const view = { id: monitor.id, name: monitor.name, status: monitor.status }
  if (monitor.pause_reason) view.pause_reason = monitor.pause_reason
  view.metadata = monitor.metadata
  return view
}

export function buildEvent(monitor, type, run) {
  const data = { monitor: eventMonitor(monitor) }
  if (run) data.run = run
  return { id: newId('evt_'), object: 'event', type, timestamp: now(), data }
}

// Queue an event if the monitor's webhook is subscribed to it. The tick sends it.
export async function emit(ctx, monitor, type, run) {
  if (!monitor.webhook || !monitor.webhook.events.includes(type)) return
  const event = buildEvent(monitor, type, run)
  await ctx.db.run(
    'INSERT INTO deliveries (id, monitor_id, body, attempt, next_at) VALUES (?, ?, ?, 0, ?)',
    [event.id, monitor.id, JSON.stringify(event), now()],
  )
}

// One delivery attempt. Never throws, the outcome is in the returned object.
export async function deliver(ctx, monitor, eventId, body) {
  const started = Date.now()
  const timestamp = String(Math.floor(started / 1000))

  // during a rotation the old secret signs as well, receivers accept either
  const secrets = [monitor.secret]
  if (monitor.old_secret && monitor.old_secret_until > now()) secrets.push(monitor.old_secret)
  const signatures = []
  for (const secret of secrets) {
    signatures.push(await signWebhook(secret, eventId, timestamp, body))
  }

  try {
    const res = await fetch(monitor.webhook.url, {
      method: 'POST',
      body,
      redirect: 'manual', // a redirect counts as a failure
      signal: AbortSignal.timeout(10_000),
      headers: {
        'content-type': 'application/json',
        'user-agent': USER_AGENT,
        'webhook-id': eventId,
        'webhook-timestamp': timestamp,
        'webhook-signature': signatures.join(' '),
      },
    })
    await res.body?.cancel()

    const result = { delivered: res.ok, status_code: res.status, duration_ms: Date.now() - started }
    if (!res.ok) result.error = 'http_status'
    return result
  } catch (e) {
    let error = 'network_error'
    if (e.name === 'TimeoutError') error = 'timeout'
    else if (/CERT|TLS|SSL|SELF_SIGNED/i.test(`${e.cause?.code} ${e.cause?.message}`)) error = 'tls_certificate'
    return { delivered: false, duration_ms: Date.now() - started, error }
  }
}

function shouldRetry(result) {
  if (result.status_code) {
    return result.status_code === 408 || result.status_code === 429 || result.status_code >= 500
  }
  return result.error === 'timeout' || result.error === 'network_error'
}

// The service pausing a monitor on its own (as opposed to the user). Sends monitor.paused.
export async function autoPause(ctx, monitor, reason, run) {
  const paused = await ctx.db.run(
    `UPDATE monitors SET status = 'paused', pause_reason = ?, next_run_at = NULL
     WHERE id = ? AND status = 'active'`,
    [reason, monitor.id],
  )
  if (paused.changes === 0) return
  await emit(ctx, { ...monitor, status: 'paused', pause_reason: reason }, 'monitor.paused', run)
}

// Sends everything that is due. Called from the tick.
export async function sendDueDeliveries(ctx) {
  const due = await ctx.db.all('SELECT * FROM deliveries WHERE next_at <= ? ORDER BY next_at', [now()])

  for (const delivery of due) {
    // push next_at forward before sending. This doubles as the claim, so two ticks
    // can't send the same attempt, and as the retry schedule if this attempt fails.
    const delay = RETRY_DELAYS_S[delivery.attempt] ?? 0
    const claimed = await ctx.db.run(
      'UPDATE deliveries SET attempt = attempt + 1, next_at = ? WHERE id = ? AND attempt = ?',
      [iso(Date.now() + delay * 1000), delivery.id, delivery.attempt],
    )
    if (claimed.changes === 0) continue

    const monitor = await getMonitor(ctx.db, delivery.monitor_id)
    if (!monitor || !monitor.webhook) {
      // webhook was removed in the meantime, nothing to send to
      await ctx.db.run('DELETE FROM deliveries WHERE id = ?', [delivery.id])
      continue
    }

    const result = await deliver(ctx, monitor, delivery.id, delivery.body)
    const attemptsLeft = delivery.attempt < RETRY_DELAYS_S.length
    if (!result.delivered && shouldRetry(result) && attemptsLeft) continue

    await ctx.db.run('DELETE FROM deliveries WHERE id = ?', [delivery.id])
    if (!result.delivered) {
      // gave up on this one. A dead endpoint pauses the monitor so it gets noticed.
      await autoPause(ctx, monitor, 'webhook_failing')
    }
  }
}
