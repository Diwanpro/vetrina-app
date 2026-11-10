import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const JsBarcode = require('jsbarcode')
const code = await fs.readFile(new URL('../lib/engine.js', import.meta.url), 'utf8')
const { sevenDaySales, sevenDayRange, purchasePayload, purchaseTotal, weightedAverage, variantBarcodes } = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`)

test('seven chronological days with exact Arabic names and zero-filled gaps', () => {
  const now = new Date(2026, 10, 10, 12)
  const rows = [
    { created_at: new Date(2026, 10, 4, 10).toISOString(), total_amount: 100 },
    { created_at: new Date(2026, 10, 4, 20).toISOString(), total_amount: '200' },
    { created_at: new Date(2026, 10, 10, 8).toISOString(), total_amount: 50 },
    { created_at: new Date(2026, 10, 3, 23).toISOString(), total_amount: 999 },
    { created_at: new Date(2026, 10, 11, 0).toISOString(), total_amount: 999 },
  ]
  const days = sevenDaySales(rows, now)
  assert.deepEqual(days.map(day => day.label), ['الأربعاء', 'الخميس', 'الجمعة', 'السبت', 'الأحد', 'الإثنين', 'الثلاثاء'])
  assert.deepEqual(days.map(day => day.value), [300, 0, 0, 0, 0, 0, 50])
  assert.equal(days[0].date, '2026-11-04')
})
test('chart date range handles month/year boundaries and an empty week', () => {
  const now = new Date(2027, 0, 2, 23)
  const range = sevenDayRange(now)
  assert.equal(new Date(range.from).getDate(), 27)
  assert.equal(new Date(range.from).getMonth(), 11)
  assert.equal(new Date(range.to).getDate(), 3)
  assert.equal(new Date(range.to).getHours(), 0)
  assert.equal(sevenDaySales([], now).reduce((sum, day) => sum + day.value, 0), 0)
})
test('purchase validation normalizes integer inputs and calculates multi-line total', () => {
  const rows = purchasePayload([{ variant_id: 'variant-a', quantity: '3', unit_cost: '100' }, { variant_id: 'variant-b', quantity: '2', unit_cost: '0' }])
  assert.equal(purchaseTotal(rows), 300)
  assert.deepEqual(rows[0], { variant_id: 'variant-a', quantity: 3, unit_cost: 100 })
})
test('invalid quantities, empty costs, duplicates and huge invoices are rejected', () => {
  for (const quantity of ['', '-1', '0', '1.5', 'abc', '2147483648']) {
    assert.throws(() => purchasePayload([{ variant_id: 'a', quantity, unit_cost: 1 }]))
  }
  for (const unit_cost of ['', '-1', '1.5', 'NaN', '2147483648']) {
    assert.throws(() => purchasePayload([{ variant_id: 'a', quantity: 1, unit_cost }]))
  }
  assert.throws(() => purchasePayload([]))
  assert.throws(() => purchasePayload([{ variant_id: 'a', quantity: 1, unit_cost: 1 }, { variant_id: 'a', quantity: 2, unit_cost: 2 }]))
  assert.throws(() => purchasePayload([{ variant_id: '', quantity: 1, unit_cost: 1 }]))
})
test('weighted cost is correct for zero stock, existing stock and fractional averages', () => {
  assert.equal(weightedAverage(0, 500, 10, 100), 100)
  assert.equal(weightedAverage(10, 50, 10, 100), 75)
  assert.ok(Math.abs(weightedAverage(10, 100, 5, 200) - 133.33333333333334) < 1e-10)
})
test('barcodes are unique per variant, preserve single supplied code and generate missing codes', () => {
  assert.deepEqual(variantBarcodes(' 1234567890123 ', 1), ['1234567890123'])
  assert.deepEqual(variantBarcodes('SHOE', 3), ['SHOE-01', 'SHOE-02', 'SHOE-03'])
  let index = 0
  assert.deepEqual(variantBarcodes('', 2, () => `ID${++index}`), ['VID1', 'VID2'])
  assert.throws(() => variantBarcodes('رمز', 1))
  assert.throws(() => variantBarcodes('a b', 1))
  assert.throws(() => variantBarcodes('A'.repeat(49), 1))
})
test('real CODE128 encoder supports generated, numeric and legacy UUID barcodes', () => {
  for (const barcode of ['1234567890123', 'SHOE-01', 'Vd5d58fd21b834fff', '78cb50c6-cb59-4924-86d8-6ea160ab050f']) {
    const output = {}
    JsBarcode(output, barcode, { format: 'CODE128' })
    assert.ok(output.encodings.length > 0)
    assert.match(output.encodings[0].data, /^[01]+$/)
  }
})
