// timestamps are RFC 3339 UTC with whole seconds, same as the Perplexity API
export function iso(ms) {
  return new Date(ms).toISOString().slice(0, 19) + 'Z'
}

export function now() {
  return iso(Date.now())
}

// error carrying a run failure code (detect_failed, judge_failed, ...)
export function runError(code, message) {
  const e = new Error(message)
  e.code = code
  return e
}
