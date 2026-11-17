import test from 'node:test'
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { newId, idAt, newWebhookSecret, signWebhook, sha256, safeEqual, hmacHex } from '../src/crypto.js'

test('ids are prefixed and time ordered', () => {
  const id = newId('mon_')
  assert.match(id, /^mon_[0-9a-z]{21}$/)
  assert.ok(idAt('mon_', Date.now() - 1000) < id)
  assert.ok(id < idAt('mon_', Date.now() + 1000))
})

test('webhook signature matches a plain node:crypto implementation', async () => {
  const secret = newWebhookSecret()
  assert.match(secret, /^whsec_[A-Za-z0-9+/]{32}$/)

  const key = Buffer.from(secret.slice(6), 'base64')
  const expected = createHmac('sha256', key).update('evt_1.1700000000.{"a":1}').digest('base64')
  assert.equal(await signWebhook(secret, 'evt_1', '1700000000', '{"a":1}'), 'v1,' + expected)
})

test('hash helpers', async () => {
  assert.equal(await sha256('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
  assert.equal(await hmacHex('k', 'msg'), createHmac('sha256', 'k').update('msg').digest('hex'))
  assert.equal(await safeEqual('same', 'same'), true)
  assert.equal(await safeEqual('same', 'other'), false)
})
