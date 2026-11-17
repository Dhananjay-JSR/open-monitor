import test from 'node:test'
import assert from 'node:assert/strict'
import { parseInterval, formatInterval, cronNext, nextRun } from '../src/schedule.js'
import { iso } from '../src/util.js'

const at = (s) => Date.parse(s)
const next = (expr, tz, from) => iso(cronNext(expr, tz, at(from)))

test('parseInterval', () => {
  assert.equal(parseInterval('30m'), 30 * 60000)
  assert.equal(parseInterval('2w'), 14 * 24 * 60 * 60000)
  for (const bad of ['0m', '32d', '5w', '1y', 'h', 15, '']) {
    assert.throws(() => parseInterval(bad), `${bad} should be rejected`)
  }
})

test('formatInterval uses the largest exact unit', () => {
  assert.equal(formatInterval(parseInterval('60m')), '1h')
  assert.equal(formatInterval(parseInterval('7d')), '1w')
  assert.equal(formatInterval(parseInterval('90m')), '90m')
})

test('cron in UTC', () => {
  // friday 09:00 -> monday 09:00
  assert.equal(next('0 9 * * 1-5', 'UTC', '2026-11-13T09:00:00Z'), '2026-11-16T09:00:00Z')
  assert.equal(next('*/15 * * * *', 'UTC', '2026-11-17T10:07:30Z'), '2026-11-17T10:15:00Z')
  assert.equal(next('0 0 1 * *', 'UTC', '2026-11-17T00:00:00Z'), '2026-12-01T00:00:00Z')
  assert.equal(next('5/20 * * * *', 'UTC', '2026-11-17T10:26:00Z'), '2026-11-17T10:45:00Z')
})

test('cron with timezones', () => {
  assert.equal(next('0 9 * * *', 'Asia/Kolkata', '2026-11-17T00:00:00Z'), '2026-11-17T03:30:00Z')
  assert.equal(next('30 8 * * *', 'America/New_York', '2026-11-17T00:00:00Z'), '2026-11-17T13:30:00Z')
})

test('cron day-of-month OR day-of-week when both are set', () => {
  // the 20th or a sunday; the 20th (friday) comes before sunday the 22nd
  assert.equal(next('0 0 20 * 0', 'UTC', '2026-11-17T00:00:00Z'), '2026-11-20T00:00:00Z')
  assert.equal(next('0 0 * * 7', 'UTC', '2026-11-17T00:00:00Z'), '2026-11-22T00:00:00Z')
})

test('cron rejects bad input', () => {
  assert.throws(() => cronNext('0 9 * *', 'UTC', 0), /five fields/)
  assert.throws(() => cronNext('61 * * * *', 'UTC', 0), /out of range/)
  assert.throws(() => cronNext('a * * * *', 'UTC', 0), /bad cron field/)
  assert.throws(() => cronNext('0 0 * * *', 'Mars/Olympus', 0), /unknown timezone/)
  assert.throws(() => cronNext('0 0 29 2 *', 'UTC', at('2026-03-01T00:00:00Z')), /31 days/)
})

test('nextRun', () => {
  assert.equal(nextRun({ type: 'interval', interval: '1h' }, 0), 3600000)
  const cron = { type: 'cron', cron: '0 0 * * *', timezone: 'UTC' }
  assert.equal(iso(nextRun(cron, at('2026-11-17T12:00:00Z'))), '2026-11-18T00:00:00Z')
})
