// Device fingerprinting for session management.
//
// The fingerprint is a SHA-256 hash of a small set of stable browser signals.
// It is a *convenience* identifier, not a security boundary: the same physical
// device will produce a different hash after a browser/OS/zoom/language change,
// and two identical tablets may collide. Session enforcement therefore treats
// it as "this browser profile", which is exactly what it is.

// Signals are kept in a fixed order so the hash is stable across releases.
export const FINGERPRINT_FIELDS = ['userAgent', 'screenWidth', 'screenHeight', 'language', 'timeZone']

// Collects the raw signals. `nav`/`screenLike`/`intl`/`cryptoImpl` are injectable
// so the pure parts can be unit-tested without a browser.
export function collectSignals({ nav = globalThis.navigator, screenLike = globalThis.screen, intl = globalThis.Intl } = {}) {
  const timeZone = (() => {
    try { return intl?.DateTimeFormat?.().resolvedOptions?.().timeZone || '' } catch { return '' }
  })()
  const signals = {
    userAgent: String(nav?.userAgent ?? '').slice(0, 512),
    screenWidth: Number(screenLike?.width ?? 0),
    screenHeight: Number(screenLike?.height ?? 0),
    language: String(nav?.language ?? '').slice(0, 35),
    timeZone: String(timeZone).slice(0, 64),
  }
  return signals
}

// Canonical string that gets hashed. Exposed for tests and for support tooling.
export function signalsToString(signals) {
  return FINGERPRINT_FIELDS.map(field => `${field}=${signals[field] ?? ''}`).join('|')
}

// Hex SHA-256. `cryptoImpl` lets tests pass node:crypto or a stub.
export async function sha256Hex(text, cryptoImpl = globalThis.crypto) {
  if (!cryptoImpl?.subtle || typeof cryptoImpl.subtle.digest !== 'function') {
    throw new Error('تعذر توليد بصمة الجهاز: المتصفح لا يدعم التشفير')
  }
  const bytes = new TextEncoder().encode(text)
  const digest = await cryptoImpl.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(digest)).map(byte => byte.toString(16).padStart(2, '0')).join('')
}

// Returns the 64-char hex fingerprint stored in user_sessions.device_fingerprint.
export async function deviceFingerprint(options = {}) {
  const cryptoImpl = options.cryptoImpl ?? globalThis.crypto
  const signals = collectSignals(options)
  return sha256Hex(signalsToString(signals), cryptoImpl)
}

// ------------------------------------------------------------------ naming
const BROWSERS = [
  [/Edg\//i, 'Edge'],
  [/OPR\/|Opera/i, 'Opera'],
  [/SamsungBrowser/i, 'Samsung Internet'],
  [/Firefox\//i, 'Firefox'],
  [/Chrome\//i, 'Chrome'],
  [/Safari\//i, 'Safari'],
]

// Order matters: Android UAs contain "Linux" and iOS UAs contain "Mac OS X".
const PLATFORMS = [
  [/Android/i, 'Android'],
  [/iPhone/i, 'iPhone'],
  [/iPad/i, 'iPad'],
  [/Windows NT/i, 'Windows'],
  [/Mac OS X|Macintosh/i, 'Mac'],
  [/CrOS/i, 'ChromeOS'],
  [/Linux/i, 'Linux'],
]

// iPadOS 13+ reports a desktop Mac UA; touch support is what distinguishes it.
function detectPlatform(ua, touchPoints = 0) {
  if (/Mac OS X|Macintosh/i.test(ua) && touchPoints > 1 && !/iPhone|iPad/i.test(ua)) return 'iPad'
  for (const [pattern, label] of PLATFORMS) if (pattern.test(ua)) return label
  return 'جهاز غير معروف'
}

function detectBrowser(ua) {
  // Edge and Opera embed "Chrome/", and Chrome embeds "Safari/", so check first.
  for (const [pattern, label] of BROWSERS) if (pattern.test(ua)) return label
  return 'متصفح غير معروف'
}

// e.g. "Chrome on Android". Used for display only, never for identity.
export function deviceName({ nav = globalThis.navigator } = {}) {
  const ua = String(nav?.userAgent ?? '')
  if (!ua) return 'جهاز غير معروف'
  const touchPoints = Number(nav?.maxTouchPoints ?? 0)
  return `${detectBrowser(ua)} on ${detectPlatform(ua, touchPoints)}`
}

// Convenience wrapper used by the app: both values in one round trip.
export async function describeDevice(options = {}) {
  const nav = options.nav ?? globalThis.navigator
  const [fingerprint] = await Promise.all([deviceFingerprint(options)])
  return { fingerprint, name: deviceName({ nav }) }
}
