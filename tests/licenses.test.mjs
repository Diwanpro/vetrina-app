import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
const code = await fs.readFile(new URL('../lib/licenses.js', import.meta.url), 'utf8')
const { LICENSE_TYPES, KEY_ALPHABET, charFromByte, buildLicenseKey, parseLicenseKey, validateBranches } = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`)

test('key alphabet avoids ambiguous glyphs and stays an exact divisor of 256', () => {
  assert.equal(KEY_ALPHABET.length, 32, 'modulo bias needs 32 symbols')
  assert.equal(256 % KEY_ALPHABET.length, 0)
  for (const glyph of ['I', 'O', '0', '1']) assert.equal(KEY_ALPHABET.includes(glyph), false)
  assert.equal(new Set(KEY_ALPHABET).size, 32)
})

test('every byte maps into the alphabet and the mapping is uniform', () => {
  const seen = new Map()
  for (let byte = 0; byte < 256; byte++) {
    const ch = charFromByte(byte)
    assert.equal(ch.length, 1)
    assert.ok(KEY_ALPHABET.includes(ch))
    seen.set(ch, (seen.get(ch) || 0) + 1)
  }
  // 256 / 32 === 8: each symbol must be produced exactly 8 times.
  assert.equal(seen.size, 32)
  for (const count of seen.values()) assert.equal(count, 8)
  for (const bad of [-1, 256, 1.5, null, 'a']) assert.throws(() => charFromByte(bad))
})

test('generated keys follow VTR/UPG-{branches}-{6 chars}', () => {
  const bytes = new Array(6).fill(0)
  assert.equal(buildLicenseKey('activation', 3, bytes), 'VTR-3-AAAAAA')
  assert.equal(buildLicenseKey('upgrade', 2, new Array(6).fill(255)), 'UPG-2-999999')
  const key = buildLicenseKey('activation', 7, [0, 31, 32, 63, 64, 95])
  assert.match(key, /^VTR-7-[A-Z2-9]{6}$/)
  assert.equal(key.length, 'VTR-7-'.length + 6)
  assert.throws(() => buildLicenseKey('bogus', 1, bytes))
  assert.throws(() => buildLicenseKey('activation', 0, bytes))
  assert.throws(() => buildLicenseKey('activation', 2147483648, bytes))
  assert.throws(() => buildLicenseKey('activation', 1, []))
})

test('parsing rejects malformed keys and enforces the expected prefix', () => {
  assert.deepEqual(parseLicenseKey(' VTR-3-X7Y9Z2 ', 'VTR'), { prefix: 'VTR', branches: 3, key: 'VTR-3-X7Y9Z2' })
  assert.equal(parseLicenseKey('UPG-12-EXTRA-2026', 'UPG').branches, 12)
  for (const bad of ['', '   ', 'VTR-0-X7Y9Z2', 'VTR-02-X7Y9Z2', 'VTR--X', 'VETRINA-LIFETIME', 'VTR-2-', 'VTR-3-X7Y9Z2 ' + 'Z'.repeat(201), null, 42]) {
    assert.throws(() => parseLicenseKey(bad))
  }
  // Pasting an upgrade key into the activation box must fail before the network.
  assert.throws(() => parseLicenseKey('UPG-2-X7Y9Z2', 'VTR'), /ترقية/)
  assert.throws(() => parseLicenseKey('VTR-2-X7Y9Z2', 'UPG'), /تفعيل/)
  assert.doesNotThrow(() => parseLicenseKey('VTR-2-X7Y9Z2'))
})

test('branch input accepts positive integers only', () => {
  assert.equal(validateBranches('1'), 1)
  assert.equal(validateBranches(' 42 '), 42)
  assert.equal(validateBranches(7), 7)
  assert.equal(validateBranches(2147483647), 2147483647)
  for (const bad of ['', '  ', '0', '-1', '1.5', '02', '1e3', 'abc', '2147483648', null, undefined, 0, -3, 1.5]) {
    assert.throws(() => validateBranches(bad))
  }
})

test('license type options match the SQL enum values', () => {
  assert.deepEqual(Object.keys(LICENSE_TYPES).sort(), ['activation', 'upgrade'])
})
