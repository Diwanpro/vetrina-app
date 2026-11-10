// License key helpers shared by the Super Admin panel and the activation form.
// The authoritative uniqueness/redeemability check is server-side in
// `public.engine_activate`; everything here is validation and presentation.

export const LICENSE_TYPES = { activation: 'Activation (VTR)', upgrade: 'Upgrade (UPG)' }
export const LICENSE_PREFIX = { activation: 'VTR', upgrade: 'UPG' }

// No I, O, 0 or 1 — keeps keys readable when dictated or copied by hand.
export const KEY_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
export const RANDOM_LENGTH = 6

const KEY_PATTERN = /^(VTR|UPG)-([1-9][0-9]{0,9})-([A-Za-z0-9-]+)$/

// Maps a byte (0-255) onto the alphabet. 32 divides 256 exactly, so a uniform
// byte yields a uniform character and no modulo bias is introduced.
export function charFromByte(byte) {
  if (!Number.isInteger(byte) || byte < 0 || byte > 255) throw new Error('byte must be 0-255')
  return KEY_ALPHABET[byte % KEY_ALPHABET.length]
}

// Mirrors the SQL generator so the panel can preview/validate locally.
// Returns e.g. "VTR-3-X7Y9Z2".
export function buildLicenseKey(type, branches, randomBytes) {
  if (!Object.hasOwn(LICENSE_PREFIX, type)) throw new Error('نوع الترخيص غير صالح')
  const n = Number(branches)
  if (!Number.isSafeInteger(n) || n < 1 || n > 2147483647) throw new Error('عدد الفروع يجب أن يكون بين 1 و 2147483647')
  if (!Array.isArray(randomBytes) || randomBytes.length < RANDOM_LENGTH) throw new Error('random bytes are required')
  const body = randomBytes.slice(0, RANDOM_LENGTH).map(charFromByte).join('')
  return `${LICENSE_PREFIX[type]}-${n}-${body}`
}

// Local pre-flight checks run before hitting the network. `mode` forces the
// expected prefix so pasting an UPG key into the activation box fails fast.
export function parseLicenseKey(key, mode) {
  if (typeof key !== 'string') throw new Error('المفتاح غير صالح')
  const trimmed = key.trim()
  if (!trimmed) throw new Error('أدخل المفتاح')
  if (trimmed.length > 200) throw new Error('المفتاح غير صالح')
  const match = trimmed.match(KEY_PATTERN)
  if (!match) throw new Error('صيغة المفتاح غير صحيحة. مثال: VTR-3-X7Y9Z2')
  if (mode && match[1] !== mode) {
    throw new Error(mode === 'VTR' ? 'هذا مفتاح ترقية. استخدمه في قسم ترقية الفروع' : 'هذا مفتاح تفعيل. استخدمه في قسم التفعيل')
  }
  const branches = Number(match[2])
  if (branches > 2147483647) throw new Error('عدد الفروع غير صالح')
  return { prefix: match[1], branches, key: trimmed }
}

// Normalises the numeric branch input from the panel (string from <input>).
export function validateBranches(value) {
  const text = String(value ?? '').trim()
  if (!/^[1-9][0-9]{0,9}$/.test(text)) throw new Error('عدد الفروع يجب أن يكون رقماً صحيحاً بين 1 و 2147483647')
  const n = Number(text)
  if (!Number.isSafeInteger(n) || n > 2147483647) throw new Error('عدد الفروع يجب أن يكون رقماً صحيحاً بين 1 و 2147483647')
  return n
}
