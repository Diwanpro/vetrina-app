import test from 'node:test'
import assert from 'node:assert/strict'
import {
  encryptCredentials, decryptCredentials, credentialHint, credentialsFingerprint,
  getMasterKey, stableStringify, connectionAad,
} from '../lib/shipping/credentials.js'

const KEY = Buffer.alloc(32, 7).toString('base64')
const ENV = { SHIPPING_MASTER_KEY: KEY }
const AAD = connectionAad({
  tenantId: '11111111-1111-4111-8111-111111111111',
  storeId: '22222222-2222-4222-8222-222222222222',
  providerCode: 'yalidine',
  environment: 'sandbox',
})

test('a 32-byte base64 or hex key is accepted, anything else fails closed', () => {
  assert.equal(getMasterKey(ENV).length, 32)
  assert.equal(getMasterKey({ SHIPPING_MASTER_KEY: Buffer.alloc(32, 9).toString('hex') }).length, 32)
  for (const bad of ['', 'short', 'not*base64*at*all', Buffer.alloc(16).toString('base64')]) {
    assert.throws(
      () => getMasterKey({ SHIPPING_MASTER_KEY: bad }),
      error => error.code === 'CONFIG' && error.status === 500 && /SHIPPING_MASTER_KEY/.test(error.message),
    )
  }
})

test('round-trip keeps every credential and never stores plaintext', () => {
  const plain = { apiId: 'yal-id-42', apiToken: 'secret-token-ABCD' }
  const payload = encryptCredentials(plain, AAD, ENV)
  assert.equal(typeof payload, 'string')
  assert.doesNotMatch(payload, /secret-token-ABCD/)
  assert.doesNotMatch(payload, /yal-id-42/)
  const envelope = JSON.parse(payload)
  assert.equal(envelope.v, 1)
  assert.equal(Buffer.from(envelope.iv, 'base64').length, 12)
  assert.equal(Buffer.from(envelope.tag, 'base64').length, 16)
  assert.deepEqual(decryptCredentials(payload, AAD, ENV), plain)
})

test('the ciphertext is bound to tenant/store/provider/environment', () => {
  const payload = encryptCredentials({ apiToken: 'abcd1234' }, AAD, ENV)
  assert.throws(
    () => decryptCredentials(payload, AAD.replace('yalidine', 'zrexpress'), ENV),
    error => error.code === 'CONFIG',
  )
  assert.throws(() => decryptCredentials(payload, '', ENV), error => error.code === 'CONFIG')
})

test('tampering with ciphertext, tag or version is rejected', () => {
  const payload = encryptCredentials({ apiToken: 'abcd1234' }, AAD, ENV)
  const cases = []
  const flipped = JSON.parse(payload)
  const data = Buffer.from(flipped.data, 'base64')
  data[0] = data[0] ^ 0xff
  cases.push({ ...flipped, data: data.toString('base64') })
  cases.push({ ...flipped, tag: Buffer.alloc(16, 1).toString('base64') })
  cases.push({ ...flipped, v: 2 })
  cases.push({ ...flipped, iv: '' })
  for (const broken of cases) {
    assert.throws(() => decryptCredentials(JSON.stringify(broken), AAD, ENV), /تعذر فك تشفير/)
  }
})

test('invalid plaintext is refused before encryption', () => {
  for (const bad of [null, {}, [], { a: 'x'.repeat(9000) }]) {
    assert.throws(() => encryptCredentials(bad, AAD, ENV), error => error.code === 'VALIDATION')
  }
})

test('the hint masks the secret and never leaks it in full', () => {
  assert.equal(credentialHint({ apiToken: 'abcdef1234' }, 'apiToken'), '•••• 1234')
  assert.equal(credentialHint({ token: 'abc' }, 'token'), '••••')
  const hint = credentialHint({ apiToken: 'super-secret-9999' }, 'apiToken')
  assert.doesNotMatch(hint, /super-secret/)
  assert.ok(hint.length < 12)
})

test('fingerprints are stable for equal objects and differ for different ones', () => {
  assert.equal(
    credentialsFingerprint({ b: 2, a: 1 }),
    credentialsFingerprint({ a: 1, b: 2 }),
  )
  assert.notEqual(
    credentialsFingerprint({ apiToken: 'one' }),
    credentialsFingerprint({ apiToken: 'two' }),
  )
  assert.equal(stableStringify({ b: 1, a: 2 }), '{"a":2,"b":1}')
})
