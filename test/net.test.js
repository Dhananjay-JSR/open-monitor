import test from 'node:test'
import assert from 'node:assert/strict'
import { isPrivateUrl } from '../src/net.js'
import { makeApp, fakeServer, searchMonitor } from './helpers.js'

test('isPrivateUrl', () => {
  const blocked = [
    'http://localhost:3000/hook',
    'http://127.0.0.1/',
    'http://2130706433/', // 127.0.0.1 as a decimal
    'http://10.1.2.3/',
    'http://172.16.0.1/',
    'http://172.31.255.255/',
    'http://192.168.1.1/',
    'http://169.254.169.254/latest/meta-data',
    'http://100.64.0.1/',
    'http://[::1]:8080/',
    'http://[fd00::1]/',
    'http://[fe80::1]/',
    'http://printer.local/',
    'http://db.internal/',
    'not a url',
  ]
  for (const url of blocked) assert.equal(isPrivateUrl(url, {}), true, url)

  const allowed = ['https://example.com/', 'http://172.32.0.1/', 'http://100.128.0.1/', 'https://localhost.example.com/', 'http://8.8.8.8/']
  for (const url of allowed) assert.equal(isPrivateUrl(url, {}), false, url)

  assert.equal(isPrivateUrl('http://localhost/', { ALLOW_PRIVATE_URLS: '1' }), false)
})

test('private urls are rejected when creating a monitor', async () => {
  const { call } = await makeApp({ ALLOW_PRIVATE_URLS: '' })

  const hook = await call('POST', '/v1/monitors', searchMonitor({ webhook: { url: 'http://localhost:9000/hook' } }))
  assert.equal(hook.status, 400)
  assert.equal(hook.body.error.param, 'webhook.url')
  assert.match(hook.body.error.message, /ALLOW_PRIVATE_URLS/)

  const page = await call('POST', '/v1/monitors', {
    name: 'p',
    targets: [{ type: 'page', url: 'http://192.168.0.10/admin' }],
    schedule: { type: 'interval', interval: '1d' },
  })
  assert.equal(page.status, 400)
  assert.equal(page.body.error.param, 'targets[0].url')
})

test('a public page that redirects to a private address is blocked', async () => {
  // the "public" page here is the local fake server, so create the monitor while private
  // urls are allowed and then turn the guard on before the run
  const site = await fakeServer(() => ({ status: 302, headers: { location: 'http://169.254.169.254/latest' }, body: '' }))
  const { call, runAndWait, ctx } = await makeApp()
  const created = await call('POST', '/v1/monitors', {
    name: 'p',
    targets: [{ type: 'page', url: site.url + '/start' }],
    schedule: { type: 'interval', interval: '1d' },
    webhook: { url: site.url + '/hook' },
  })
  ctx.env.ALLOW_PRIVATE_URLS = ''

  const run = await runAndWait(created.body.id)
  assert.equal(run.status, 'failed')
  assert.equal(run.target_errors[0].code, 'blocked')
  assert.equal(site.requests.length, 0) // not even the first hop, it is private too

  const hookTest = (await call('POST', `/v1/monitors/${created.body.id}/webhook/test`)).body
  assert.equal(hookTest.delivered, false)
  assert.equal(hookTest.error, 'blocked_address')
  site.close()
})
