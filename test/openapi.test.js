import test from 'node:test'
import assert from 'node:assert/strict'
import { makeApp } from './helpers.js'

// every route app.js answers, as method + path template. Adding a route means adding it here
// and to src/openapi.js, otherwise this test fails.
const ROUTES = [
  ['get', '/health'],
  ['get', '/openapi.json'],
  ['post', '/tick'],
  ['get', '/v1/monitors'],
  ['post', '/v1/monitors'],
  ['get', '/v1/monitors/{id}'],
  ['patch', '/v1/monitors/{id}'],
  ['delete', '/v1/monitors/{id}'],
  ['post', '/v1/monitors/{id}/pause'],
  ['post', '/v1/monitors/{id}/resume'],
  ['post', '/v1/monitors/{id}/run'],
  ['post', '/v1/monitors/{id}/webhook/test'],
  ['get', '/v1/monitors/{id}/runs'],
  ['get', '/v1/monitors/{id}/runs/{run_id}'],
  ['get', '/v1/monitors/{id}/deliveries'],
]

test('the spec is public and describes every route', async () => {
  const { call } = await makeApp()
  const res = await call('GET', '/openapi.json', undefined, { authorization: '' })
  assert.equal(res.status, 200)
  const spec = res.body
  assert.equal(spec.openapi, '3.1.0')
  assert.match(spec.servers[0].url, /^http/)

  for (const [method, path] of ROUTES) {
    assert.ok(spec.paths[path]?.[method], `${method.toUpperCase()} ${path} is missing from the spec`)
  }
  const described = Object.entries(spec.paths).flatMap(([path, ops]) => Object.keys(ops).filter((k) => k !== 'parameters').map((m) => `${m} ${path}`))
  assert.deepEqual(described.sort(), ROUTES.map(([m, p]) => `${m} ${p}`).sort(), 'the spec lists a route the server does not have')
})

test('every $ref in the spec points at something', async () => {
  const { call } = await makeApp()
  const spec = (await call('GET', '/openapi.json')).body
  const refs = JSON.stringify(spec).match(/"\$ref":"[^"]+"/g)
  for (const ref of new Set(refs)) {
    const path = ref.slice(8, -1).replace('#/', '').split('/')
    assert.ok(path.reduce((node, key) => node?.[key], spec), `${ref} does not resolve`)
  }
})

test('behind a trusted proxy the spec names the public https address', async () => {
  const forwarded = { authorization: '', 'x-forwarded-proto': 'https', 'x-forwarded-host': 'monitor.example.com' }
  const direct = await makeApp()
  assert.equal((await direct.call('GET', '/openapi.json', undefined, forwarded)).body.servers[0].url, 'http://monitor.test')

  const proxied = await makeApp({ TRUST_PROXY: '1' })
  assert.equal((await proxied.call('GET', '/openapi.json', undefined, forwarded)).body.servers[0].url, 'https://monitor.example.com')
  // a junk host header is ignored
  const junk = await proxied.call('GET', '/openapi.json', undefined, { ...forwarded, 'x-forwarded-host': 'evil.com/<script>' })
  assert.equal(junk.body.servers[0].url, 'https://monitor.test')
})
