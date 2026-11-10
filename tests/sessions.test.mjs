import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { webcrypto, createHash } from 'node:crypto'

const deviceCode = await fs.readFile(new URL('../lib/device.js', import.meta.url), 'utf8')
const sessionCode = await fs.readFile(new URL('../lib/sessions.js', import.meta.url), 'utf8')
const device = await import(`data:text/javascript;base64,${Buffer.from(deviceCode).toString('base64')}`)
const sessions = await import(`data:text/javascript;base64,${Buffer.from(sessionCode).toString('base64')}`)

const { collectSignals, signalsToString, sha256Hex, deviceFingerprint, deviceName, FINGERPRINT_FIELDS } = device
const { planSession, selectOldestSession, MAX_ACTIVE_SESSIONS, sortSessions } = sessions

const nav = { userAgent: 'Mozilla/5.0 (Linux; Android 14) Chrome/120.0.0.0', language: 'ar-DZ', maxTouchPoints: 5 }
const screen = { width: 1080, height: 2400 }
const intl = { DateTimeFormat: () => ({ resolvedOptions: () => ({ timeZone: 'Africa/Algiers' }) }) }
const opts = { nav, screenLike: screen, intl, cryptoImpl: webcrypto }

test('fingerprint is a 64-char lowercase hex SHA-256 of the five signals', async () => {
  const fingerprint = await deviceFingerprint(opts)
  assert.match(fingerprint, /^[0-9a-f]{64}$/)
  // Must match a straight SHA-256 of the canonical string.
  const expected = createHash('sha256').update(signalsToString(collectSignals({ nav, screenLike: screen, intl }))).digest('hex')
  assert.equal(fingerprint, expected)
  assert.deepEqual(FINGERPRINT_FIELDS, ['userAgent', 'screenWidth', 'screenHeight', 'language', 'timeZone'])
  const canonical = signalsToString(collectSignals({ nav, screenLike: screen, intl }))
  assert.ok(canonical.includes('userAgent='))
  assert.ok(canonical.includes('screenWidth=1080'))
  assert.ok(canonical.includes('timeZone=Africa/Algiers'))
})

test('fingerprint is stable for the same device and differs when a signal changes', async () => {
  assert.equal(await deviceFingerprint(opts), await deviceFingerprint(opts))
  const otherScreen = await deviceFingerprint({ ...opts, screenLike: { width: 800, height: 600 } })
  assert.notEqual(otherScreen, await deviceFingerprint(opts))
  const otherTz = await deviceFingerprint({ ...opts, intl: { DateTimeFormat: () => ({ resolvedOptions: () => ({ timeZone: 'Europe/Paris' }) }) } })
  assert.notEqual(otherTz, await deviceFingerprint(opts))
  const otherLang = await deviceFingerprint({ ...opts, nav: { ...nav, language: 'fr-FR' } })
  assert.notEqual(otherLang, await deviceFingerprint(opts))
})

test('missing browser APIs degrade gracefully instead of throwing', async () => {
  const fingerprint = await deviceFingerprint({ nav: {}, screenLike: {}, intl: {}, cryptoImpl: webcrypto })
  assert.match(fingerprint, /^[0-9a-f]{64}$/)
  // An unusable Intl must not crash the fingerprint.
  const broken = await deviceFingerprint({ ...opts, intl: { DateTimeFormat: () => { throw new Error('nope') } } })
  assert.match(broken, /^[0-9a-f]{64}$/)
  await assert.rejects(() => deviceFingerprint({ ...opts, cryptoImpl: {} }), /التشفير/)
})

test('sha256Hex matches known vectors', async () => {
  assert.equal(await sha256Hex('', webcrypto), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
  assert.equal(await sha256Hex('abc', webcrypto), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
})

test('device names read "Browser on Platform"', () => {
  assert.equal(deviceName({ nav: { userAgent: nav.userAgent } }), 'Chrome on Android')
  assert.equal(deviceName({ nav: { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36' } }), 'Chrome on Windows')
  // Edge and Opera both contain "Chrome/" and must not be misreported.
  assert.equal(deviceName({ nav: { userAgent: 'Mozilla/5.0 (Windows NT 10.0) Chrome/120 Safari/537.36 Edg/120.0' } }), 'Edge on Windows')
  assert.equal(deviceName({ nav: { userAgent: 'Mozilla/5.0 (X11; Linux x86_64) Chrome/120 Safari/537.36 OPR/106' } }), 'Opera on Linux')
  assert.equal(deviceName({ nav: { userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605 Safari/605' } }), 'Safari on Mac')
  assert.equal(deviceName({ nav: { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) Version/17 Safari/604' } }), 'Safari on iPhone')
  // iPadOS 13+ sends a desktop Mac UA; touch points identify it.
  assert.equal(deviceName({ nav: { userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Safari/605', maxTouchPoints: 5 } }), 'Safari on iPad')
  assert.equal(deviceName({ nav: { userAgent: 'Mozilla/5.0 (Linux; Android 13) SamsungBrowser/23 Chrome/115' } }), 'Samsung Internet on Android')
  assert.equal(deviceName({ nav: {} }), 'جهاز غير معروف')
})

const row = (id, fingerprint, isActive, lastActive) => ({ id, device_fingerprint: fingerprint, is_active: isActive, last_active: lastActive })

test('planSession covers touch, revive, insert and evict', () => {
  assert.equal(MAX_ACTIVE_SESSIONS, 2)
  assert.equal(planSession([], 'A').action, 'insert')
  assert.equal(planSession([row('1', 'A', true, '2026-01-01')], 'A').action, 'touch')
  // A row that exists but is logged out must be revived, not re-inserted:
  // UNIQUE(user_id, device_fingerprint) would otherwise reject the insert.
  assert.equal(planSession([row('1', 'A', false, '2026-01-01')], 'A').action, 'revive')
  assert.equal(planSession([row('1', 'A', true, '2026-01-01'), row('2', 'B', true, '2026-02-01')], 'C').action, 'evict')
  assert.equal(planSession([row('1', 'A', true, '2026-01-01'), row('2', 'B', false, '2026-02-01')], 'C').action, 'insert')
})

test('eviction picks the least recently active session', () => {
  const rows = [row('1', 'A', true, '2026-03-01T00:00:00Z'), row('2', 'B', true, '2026-01-01T00:00:00Z')]
  assert.equal(planSession(rows, 'C').evict.id, '2')
  // NULL last_active is the stalest possible value.
  const withNull = [row('1', 'A', true, '2026-03-01T00:00:00Z'), row('2', 'B', true, null)]
  assert.equal(planSession(withNull, 'C').evict.id, '2')
  // Tie broken deterministically by id, so devices cannot ping-pong.
  const tied = [row('b', 'B', true, '2026-01-01T00:00:00Z'), row('a', 'A', true, '2026-01-01T00:00:00Z')]
  assert.equal(planSession(tied, 'C').evict.id, 'a')
  assert.equal(selectOldestSession([], 'A'), null)
  // Never evict the device that is signing in.
  assert.equal(selectOldestSession([row('1', 'C', true, '2026-01-01')], 'C'), null)
})

test('validates inputs and sorts newest-first for display', () => {
  assert.throws(() => planSession([], ''))
  assert.deepEqual(sortSessions([row('1', 'A', true, '2026-01-01T00:00:00Z'), row('2', 'B', true, '2026-05-01T00:00:00Z')]).map(r => r.id), ['2', '1'])
  assert.deepEqual(sortSessions(null), [])
})
