import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'

const load = async path =>
  import(`data:text/javascript;base64,${Buffer.from(await fs.readFile(new URL(path, import.meta.url), 'utf8')).toString('base64')}`)

const { trialExpired, trialDaysLeft, subscriptionLocked, TRIAL_DAYS } = await load('../lib/access.js')
const { normalizePhone, phoneToEmail, validateSignup, whatsappLink, WHATSAPP_NUMBER } = await load('../lib/trial.js')

const DAY = 86400000
const now = new Date('2026-11-10T12:00:00Z')
const daysAgo = d => new Date(now.getTime() - d * DAY).toISOString()

test('trial window is 7 days and locks strictly after day 7', () => {
  assert.equal(TRIAL_DAYS, 7)
  assert.equal(trialExpired({ is_active: false, trial_start_date: daysAgo(0) }, now), false)
  assert.equal(trialExpired({ is_active: false, trial_start_date: daysAgo(6.9) }, now), false)
  assert.equal(trialExpired({ is_active: false, trial_start_date: daysAgo(7) }, now), false)
  assert.equal(trialExpired({ is_active: false, trial_start_date: daysAgo(7.01) }, now), true)
})

test('activated tenants never lock, even with an old trial date', () => {
  const tenant = { is_active: true, trial_start_date: daysAgo(999), subscription_end_date: daysAgo(30) }
  assert.equal(trialExpired(tenant, now), false)
  assert.equal(trialDaysLeft(tenant, now), null)
  assert.equal(subscriptionLocked(tenant, now), false)
})

test('a paid subscription that ended and was switched off still locks', () => {
  const tenant = { is_active: false, trial_start_date: daysAgo(1), subscription_end_date: daysAgo(2) }
  assert.equal(trialExpired(tenant, now), false)
  assert.equal(subscriptionLocked(tenant, now), true)
})

test('legacy tenants with no trial date are never locked by the trial rule', () => {
  assert.equal(trialExpired({ is_active: false, trial_start_date: null }, now), false)
  assert.equal(trialExpired({ is_active: false }, now), false)
  assert.equal(trialExpired(null, now), false)
  assert.equal(trialExpired({ is_active: false, trial_start_date: 'not-a-date' }, now), false)
})

test('the server flag wins over local clock maths', () => {
  // A tampered client clock must not unlock a trial the server already closed.
  assert.equal(trialExpired({ is_active: false, trial_start_date: daysAgo(1), trial_expired: true }, now), true)
  assert.equal(trialExpired({ is_active: false, trial_start_date: daysAgo(30), trial_expired: false }, now), false)
})

test('days left counts down and never goes negative', () => {
  assert.equal(trialDaysLeft({ is_active: false, trial_start_date: daysAgo(0) }, now), 7)
  assert.equal(trialDaysLeft({ is_active: false, trial_start_date: daysAgo(1) }, now), 6)
  assert.equal(trialDaysLeft({ is_active: false, trial_start_date: daysAgo(6) }, now), 1)
  assert.equal(trialDaysLeft({ is_active: false, trial_start_date: daysAgo(40) }, now), 0)
})

test('phones are normalized to digits so one account cannot be made twice', () => {
  assert.equal(normalizePhone('0555 12 34 56'), '0555123456')
  assert.equal(normalizePhone('+213 555 12 34 56'), '213555123456')
  assert.equal(normalizePhone('05-55-12-34-56'), '0555123456')
  assert.equal(normalizePhone(null), '')
})

test('the derived email is what signUp sends and what the RPC verifies', () => {
  assert.equal(phoneToEmail('0555 12 34 56'), '0555123456@vetrina.app')
  assert.throws(() => phoneToEmail(''))
})

test('signup rejects empty, oversized and too-short input', () => {
  const valid = { storeName: ' محلي ', ownerName: ' علي ', phone: '0555 12 34 56', password: 'secret123' }
  assert.deepEqual(validateSignup(valid), {
    storeName: 'محلي', ownerName: 'علي', phone: '0555123456', email: '0555123456@vetrina.app', password: 'secret123',
  })
  assert.throws(() => validateSignup({ ...valid, storeName: '  ' }), /اسم المحل مطلوب/)
  assert.throws(() => validateSignup({ ...valid, ownerName: '' }), /اسم المالك مطلوب/)
  assert.throws(() => validateSignup({ ...valid, storeName: 'x'.repeat(201) }), /طويل/)
  assert.throws(() => validateSignup({ ...valid, phone: '123' }), /رقم الهاتف غير صالح/)
  assert.throws(() => validateSignup({ ...valid, password: 'short' }), /8 أحرف/)
})

test('whatsapp link uses the required support number in international form', () => {
  const link = whatsappLink('مرحبا')
  assert.equal(WHATSAPP_NUMBER, '0798726063')
  assert.ok(link.startsWith('https://wa.me/213798726063?text='))
  assert.equal(decodeURIComponent(link.split('text=')[1]), 'مرحبا')
})
