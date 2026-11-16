// SERVER-ONLY VAPID configuration (v3.1).
//
// One environment variable, PUSH_VAPID_CONFIG, holds the key pair. It is a
// base64-encoded JSON object so shell/connector tooling cannot accidentally
// coerce it into a nested object. Plain JSON is also accepted for local .env.
// Never expose the private key to the browser.

const URL_SAFE = /^[A-Za-z0-9_-]+$/

function byteLength(value) {
  try { return Buffer.from(value, 'base64url').length } catch { return 0 }
}

function parseConfig(raw) {
  const text = String(raw || '').trim()
  if (!text) return null
  let json = text
  if (!text.startsWith('{')) {
    try { json = Buffer.from(text, 'base64').toString('utf8') } catch { return null }
  }
  let parsed
  try { parsed = JSON.parse(json) } catch { return null }
  const publicKey = String(parsed.publicKey || '').trim()
  const privateKey = String(parsed.privateKey || '').trim()
  const subject = String(parsed.subject || '').trim()
  if (!URL_SAFE.test(publicKey) || !URL_SAFE.test(privateKey)) return null
  if (byteLength(publicKey) !== 65 || byteLength(privateKey) !== 32) return null
  if (!/^(mailto:|https:\/\/)/i.test(subject)) return null
  return { publicKey, privateKey, subject }
}

export function vapidConfig() {
  const combined = parseConfig(process.env.PUSH_VAPID_CONFIG)
  if (combined) return combined
  // Optional split form for local development / other hosts.
  const split = parseConfig(JSON.stringify({
    publicKey: process.env.PUSH_VAPID_PUBLIC_KEY || '',
    privateKey: process.env.PUSH_VAPID_PRIVATE_KEY || '',
    subject: process.env.PUSH_VAPID_SUBJECT || 'mailto:support@vetrina.app',
  }))
  return split
}

export function publicVapidKey() {
  return vapidConfig()?.publicKey || ''
}

export function pushConfigured() {
  return Boolean(vapidConfig())
}
