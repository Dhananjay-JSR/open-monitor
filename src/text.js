const ENTITIES = { nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" }
const BLOCK_TAGS = 'p|div|br|li|tr|h[1-6]|section|article|header|footer|ul|ol|table|pre|blockquote'

// Rough text extraction for diffing. Not a sanitizer, the result is never rendered as HTML.
export function htmlToText(html) {
  const text = html
    .replace(/<(script|style|noscript|svg|head)\b[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(new RegExp(`</?(${BLOCK_TAGS})\\b[^>]*>`, 'gi'), '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&(nbsp|amp|lt|gt|quot|#39);/g, (_, name) => ENTITIES[name])

  return text
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join('\n')
}

const encoder = new TextEncoder()
const byteLength = (s) => encoder.encode(s).length

// LCS based line diff. Returns [tag, line] pairs where tag is ' ', '-' or '+'.
function diffLines(a, b) {
  // strip the common prefix/suffix first, pages usually change in one small area
  let head = 0
  while (head < a.length && head < b.length && a[head] === b[head]) head++
  let tail = 0
  while (
    tail < a.length - head &&
    tail < b.length - head &&
    a[a.length - 1 - tail] === b[b.length - 1 - tail]
  ) {
    tail++
  }

  const x = a.slice(head, a.length - tail)
  const y = b.slice(head, b.length - tail)
  const ops = a.slice(0, head).map((line) => [' ', line])

  if (x.length * y.length > 4_000_000) {
    // TODO: use Myers here. For now a huge changed block is shown as remove-all + add-all.
    for (const line of x) ops.push(['-', line])
    for (const line of y) ops.push(['+', line])
  } else {
    const width = y.length + 1
    const lcs = new Uint16Array((x.length + 1) * width)
    for (let i = x.length - 1; i >= 0; i--) {
      for (let j = y.length - 1; j >= 0; j--) {
        if (x[i] === y[j]) lcs[i * width + j] = lcs[(i + 1) * width + j + 1] + 1
        else lcs[i * width + j] = Math.max(lcs[(i + 1) * width + j], lcs[i * width + j + 1])
      }
    }
    let i = 0
    let j = 0
    while (i < x.length || j < y.length) {
      if (i < x.length && j < y.length && x[i] === y[j]) {
        ops.push([' ', x[i]])
        i++
        j++
      } else if (j >= y.length || (i < x.length && lcs[(i + 1) * width + j] >= lcs[i * width + j + 1])) {
        ops.push(['-', x[i++]])
      } else {
        ops.push(['+', y[j++]])
      }
    }
  }

  for (const line of a.slice(a.length - tail)) ops.push([' ', line])
  return ops
}

// group changes into hunks with one line of context on each side
function buildHunks(ops) {
  const hunks = []
  let hunk = null
  let oldLine = 1
  let newLine = 1

  ops.forEach(([tag, line], i) => {
    if (tag !== ' ') {
      if (!hunk) {
        hunk = { oldStart: oldLine, newStart: newLine, lines: [], closed: false }
        hunks.push(hunk)
        if (i > 0) {
          hunk.oldStart--
          hunk.newStart--
          hunk.lines.push(' ' + ops[i - 1][1])
        }
      }
      hunk.lines.push(tag + line)
      hunk.closed = false
    } else if (hunk && !hunk.closed) {
      hunk.lines.push(' ' + line)
      hunk.closed = true // one trailing context line; another unchanged line ends the hunk
    } else {
      hunk = null
    }
    if (tag !== '+') oldLine++
    if (tag !== '-') newLine++
  })
  return hunks
}

// Unified diff without file headers, capped at `limit` bytes (24 KiB in the Perplexity API).
export function unifiedDiff(before, after, limit = 24576) {
  const ops = diffLines(before.split('\n'), after.split('\n'))
  const added = ops.filter(([tag]) => tag === '+').length
  const removed = ops.filter(([tag]) => tag === '-').length

  let unified = ''
  let used = 0
  let truncated = false

  for (const hunk of buildHunks(ops)) {
    const room = limit - used - 40 // leave space for the @@ header
    let lines = []
    let size = 0
    for (const line of hunk.lines) {
      const bytes = byteLength(line) + 1
      if (size + bytes > room) {
        truncated = true
        break
      }
      lines.push(line)
      size += bytes
    }
    if (lines.length === 0 && unified === '' && room > 4) {
      // a single line bigger than the limit: cut it rather than return an empty diff
      lines = [[...hunk.lines[0]].slice(0, Math.floor(room / 4) - 1).join('')]
    }
    if (lines.length === 0) break

    // header counts only the lines we actually kept
    const oldCount = lines.filter((l) => l[0] !== '+').length
    const newCount = lines.filter((l) => l[0] !== '-').length
    const oldStart = oldCount ? hunk.oldStart : hunk.oldStart - 1
    const newStart = newCount ? hunk.newStart : hunk.newStart - 1
    const text = `@@ -${oldStart},${oldCount} +${newStart},${newCount} @@\n${lines.join('\n')}\n`

    unified += text
    used += byteLength(text)
    if (truncated) break
  }

  return { unified, added_lines: added, removed_lines: removed, truncated }
}
