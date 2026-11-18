import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { assembleDashboard } from '../src/dashboard/assemble.js'

const dir = new URL('../src/dashboard/', import.meta.url)
const read = (name) => readFileSync(new URL(name, dir), 'utf8')

test('the dashboard is one self-contained document', () => {
  const page = assembleDashboard({
    html: read('index.html'),
    styles: { 'tokens.css': read('tokens.css'), 'app.css': read('app.css') },
    script: read('app.js'),
    fonts: Object.fromEntries(['geist-variable.woff2', 'bricolage-grotesque-700.woff2'].map((name) => [name, readFileSync(new URL('fonts/' + name, dir)).toString('base64')])),
  })

  // nothing left that would need another request (the CSP would block it anyway)
  assert.equal(/<link\b/.test(page), false)
  assert.equal(/<script[^>]+src=/.test(page), false)
  assert.equal(page.includes("url('fonts/"), false)
  assert.ok(page.includes('data:font/woff2;base64,'))
  assert.ok(page.includes('window.openMonitor'))
  assert.ok(page.includes('--color-accent'))
})

test('the dashboard script never builds html from strings', () => {
  // api data is untrusted (page titles, snippets, diffs), it must only ever be set as text
  const script = read('app.js')
  for (const sink of ['innerHTML', 'outerHTML', 'insertAdjacentHTML', 'document.write']) {
    assert.equal(script.includes(sink), false, sink)
  }
})
