// SERVER-ONLY: AES-256-GCM envelope for merchant courier credentials.
//
// The browser never imports this file (it would fail on node:crypto). The
// settings tab posts plaintext keys over the authenticated HTTPS request to a
// Next.js Route Handler; this module encrypts them before they reach Postgres,
// and only the server gateway can decrypt them. The ciphertext is bound to an
// AAD string (tenant:store:provider:environment), so copying a row to another
// branch or environment cannot be replayed.
//
// SHIPPING_MASTER_KEY must be 32 bytes supplied as base64 or hex. Generate it
// with: openssl rand -base64 32   (never prefix it with NEXT_PUBLIC_).

import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import { ShippingError } from './contract.js'

const ALGORITHM = 'aes-256-gcm'
const VERSION = 1
const IV_BYTES = 12
const TAG_BYTES = 16
const KEY_BYTES = 32
const MAX_PLAINTEXT_BYTES = 8192

/** Stable JSON so two identical credential objects share one fingerprint. */
export function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`
}

function decodeKey(raw) {
  const compact = String(raw ?? '').trim().replace(/\s/g, '')
  if (!compact) return null
  if (/^[0-9a-fA-F]{64}$/.test(compact)) return Buffer.from(compact, 'hex')
  const decoded = Buffer.from(compact, 'base64')
  // Buffer.from() silently ignores garbage; compare a canonical re-encoding.
  if (decoded.toString('base64').replace(/=+$/, '') !== compact.replace(/=+$/, '')) return null
  return decoded
}

export function getMasterKey(env = process.env) {
  const key = decodeKey(env.SHIPPING_MASTER_KEY)
  if (!key || key.length !== KEY_BYTES) {
    throw new ShippingError(
      'CONFIG',
      'SHIPPING_MASTER_KEY غير مضبوط أو غير صالح. يجب أن يكون مفتاحاً عشوائياً من 32 بايت بترميز base64 أو hex.',
      500,
    )
  }
  return key
}

function assertPlainObject(plain) {
  if (!plain || typeof plain !== 'object' || Array.isArray(plain) || !Object.keys(plain).length) {
    throw new ShippingError('VALIDATION', 'بيانات المفاتيح غير صالحة', 400)
  }
  const text = stableStringify(plain)
  if (Buffer.byteLength(text, 'utf8') > MAX_PLAINTEXT_BYTES) {
    throw new ShippingError('VALIDATION', 'بيانات المفاتيح كبيرة جداً', 400)
  }
  return text
}

/** Encrypts a credential object into a serialisable text envelope. */
export function encryptCredentials(plain, aad = '', env = process.env) {
  const text = assertPlainObject(plain)
  const key = getMasterKey(env)
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv(ALGORITHM, key, iv, { authTagLength: TAG_BYTES })
  cipher.setAAD(Buffer.from(String(aad), 'utf8'))
  const data = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()])
  const envelope = {
    v: VERSION,
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: data.toString('base64'),
  }
  return JSON.stringify(envelope)
}

/** Decrypts an envelope. Any tampering, wrong key or wrong AAD fails closed. */
export function decryptCredentials(payload, aad = '', env = process.env) {
  try {
    const envelope = typeof payload === 'string' ? JSON.parse(payload) : payload
    if (!envelope || envelope.v !== VERSION) throw new Error('version')
    const iv = Buffer.from(String(envelope.iv || ''), 'base64')
    const tag = Buffer.from(String(envelope.tag || ''), 'base64')
    const data = Buffer.from(String(envelope.data || ''), 'base64')
    if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES || !data.length) throw new Error('shape')

    const key = getMasterKey(env)
    const decipher = createDecipheriv(ALGORITHM, key, iv, { authTagLength: TAG_BYTES })
    decipher.setAAD(Buffer.from(String(aad), 'utf8'))
    decipher.setAuthTag(tag)
    const text = Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8')
    const plain = JSON.parse(text)
    if (!plain || typeof plain !== 'object' || Array.isArray(plain)) throw new Error('plain')
    return plain
  } catch {
    // Never leak the ciphertext, the AAD or the underlying crypto error.
    throw new ShippingError('CONFIG', 'تعذر فك تشفير مفاتيح الشحن. تحقق من SHIPPING_MASTER_KEY وأعد حفظ المفاتيح.', 500)
  }
}

/** A short, non-secret fingerprint to detect a key change without decrypting. */
export function credentialsFingerprint(plain) {
  return createHash('sha256').update(stableStringify(plain), 'utf8').digest('hex').slice(0, 16)
}

/** "•••• 4AF2" — safe to store in the DB and show in the dashboard. */
export function credentialHint(plain, hintField = null) {
  const value = hintField && plain?.[hintField] != null
    ? String(plain[hintField])
    : Object.values(plain || {}).filter(item => typeof item === 'string').slice(-1)[0] || ''
  const trimmed = value.trim()
  if (trimmed.length <= 4) return '••••'
  return `•••• ${trimmed.slice(-4)}`
}

/** The AAD that binds a ciphertext to exactly one connection. */
export function connectionAad({ tenantId, storeId, providerCode, environment }) {
  return `vetrina:shipping:v1:${tenantId}:${storeId}:${providerCode}:${environment}`
}
