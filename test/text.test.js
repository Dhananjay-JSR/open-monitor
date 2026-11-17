import test from 'node:test'
import assert from 'node:assert/strict'
import { htmlToText, unifiedDiff } from '../src/text.js'

test('htmlToText drops markup, scripts and styles', () => {
  const html = `<html><head><title>T</title><style>p{color:red}</style></head>
    <body><h1>Release  notes</h1><script>track()</script>
    <p>Version&nbsp;2 &amp; up</p><ul><li>One</li><li>Two</li></ul><!-- hidden --></body></html>`
  assert.equal(htmlToText(html), 'Release notes\nVersion 2 & up\nOne\nTwo')
})

test('single change gets one line of context', () => {
  const d = unifiedDiff('a\nb\nc\nd\ne', 'a\nb\nX\nd\ne')
  assert.equal(d.unified, '@@ -2,3 +2,3 @@\n b\n-c\n+X\n d\n')
  assert.equal(d.added_lines, 1)
  assert.equal(d.removed_lines, 1)
  assert.equal(d.truncated, false)
})

test('changes far apart become separate hunks', () => {
  const d = unifiedDiff('1\n2\n3\n4\n5\n6\n7', '1\nB\n3\n4\n5\nF\n7\n8')
  assert.equal(d.unified, '@@ -1,3 +1,3 @@\n 1\n-2\n+B\n 3\n@@ -5,3 +5,4 @@\n 5\n-6\n+F\n 7\n+8\n')
  assert.equal(d.added_lines, 3)
  assert.equal(d.removed_lines, 2)
})

test('identical text gives an empty diff', () => {
  const d = unifiedDiff('same\ntext', 'same\ntext')
  assert.deepEqual(d, { unified: '', added_lines: 0, removed_lines: 0, truncated: false })
})

test('truncation respects the byte limit but counts all lines', () => {
  const before = Array.from({ length: 400 }, (_, i) => `old line ${i}`).join('\n')
  const after = Array.from({ length: 400 }, (_, i) => `new line ${i}`).join('\n')
  const d = unifiedDiff(before, after, 1000)

  assert.equal(d.truncated, true)
  assert.ok(Buffer.byteLength(d.unified) <= 1000)
  assert.equal(d.added_lines, 400)
  assert.equal(d.removed_lines, 400)

  // the hunk header should match what is actually shown
  const shownRemoved = d.unified.split('\n').filter((l) => l[0] === '-').length
  const headerCount = Number(/^@@ -\d+,(\d+)/.exec(d.unified)[1])
  assert.equal(headerCount, shownRemoved)
})
