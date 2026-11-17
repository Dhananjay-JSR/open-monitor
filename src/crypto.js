// WebCrypto only, so this works on Node and on Cloudflare Workers.
const encoder = new TextEncoder()

function toHex(buffer) {
  return [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

function toBase64(buffer) {
  return btoa(String.fromCharCode(...new Uint8Array(buffer)))
}

function randomBytes(n) {
  return crypto.getRandomValues(new Uint8Array(n))
}

// ids start with a base36 timestamp so they sort by creation time
export function idAt(prefix, ms) {
  return prefix + Math.floor(ms).toString(36).padStart(9, '0')
}

export function newId(prefix) {
  const suffix = [...randomBytes(12)].map((b) => (b % 36).toString(36)).join('')
  return idAt(prefix, Date.now()) + suffix
}

export function randomToken() {
  return toHex(randomBytes(32))
}

export async function sha256(text) {
  return toHex(await crypto.subtle.digest('SHA-256', encoder.encode(text)))
}

async function hmac(keyBytes, text) {
  const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  return crypto.subtle.sign('HMAC', key, encoder.encode(text))
}

export async function hmacHex(secret, text) {
  return toHex(await hmac(encoder.encode(secret), text))
}

// compare hashes rather than the raw strings so timing doesn't leak the secret
export async function safeEqual(a, b) {
  return (await sha256(String(a))) === (await sha256(String(b)))
}

// Standard Webhooks (standardwebhooks.com): secret is "whsec_" + base64 key
export function newWebhookSecret() {
  return 'whsec_' + toBase64(randomBytes(24))
}

export async function signWebhook(secret, id, timestamp, body) {
  const key = Uint8Array.from(atob(secret.slice('whsec_'.length)), (c) => c.charCodeAt(0))
  const signature = await hmac(key, `${id}.${timestamp}.${body}`)
  return 'v1,' + toBase64(signature)
}
