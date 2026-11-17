// Guard against using the server to reach internal addresses (SSRF) through webhook
// or page urls. Off when ALLOW_PRIVATE_URLS is set, which you want for local development.
//
// NOTE: this looks at the hostname as written. A public DNS name that resolves to a
// private address, or a single-label docker service name, still gets through.

const PRIVATE_HOSTS = [
  /^localhost$/,
  /\.(local|internal|localhost)$/,
  /^0\.0\.0\.0$/,
  /^127\./,
  /^10\./,
  /^192\.168\./,
  /^169\.254\./, // link-local, includes cloud metadata endpoints
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./, // carrier-grade NAT
  /^\[::1?\]$/,
  /^\[f[cd]/, // unique local
  /^\[fe[89ab]/, // link-local
  /^\[::ffff:/, // ipv4-mapped
]

export function isPrivateUrl(url, env) {
  if (env.ALLOW_PRIVATE_URLS) return false
  let host
  try {
    // the URL parser already normalises things like http://2130706433/ to 127.0.0.1
    host = new URL(url).hostname.toLowerCase()
  } catch {
    return true
  }
  return PRIVATE_HOSTS.some((pattern) => pattern.test(host))
}
