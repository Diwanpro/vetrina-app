import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const JsBarcode = require('jsbarcode')
const code = await fs.readFile(new URL('../lib/engine.js', import.meta.url), 'utf8')
const { sevenDaySales, sevenDayRange, sevenDayBreakdown, splitPayment, purchasePayload, purchaseTotal, weightedAverage, variantBarcodes } = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`)

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
test('payment split never invents money and always adds back to the invoice', () => {
  // The dashboard drill-down shows four numbers that a shopkeeper will add up
  // by hand, so the parts must equal the whole for every combination.
  const cases = [
    [{ total_amount: 1000, cash_amount: 1000, payment_method: 'cash' }, { total: 1000, cash: 1000, credit: 0, check: 0 }],
    [{ total_amount: 1000, cash_amount: 0, payment_method: 'credit' }, { total: 1000, cash: 0, credit: 1000, check: 0 }],
    [{ total_amount: 1000, cash_amount: 0, payment_method: 'check' }, { total: 1000, cash: 0, credit: 0, check: 1000 }],
    [{ total_amount: 1000, cash_amount: 0, payment_method: 'ccp' }, { total: 1000, cash: 0, credit: 0, check: 1000 }],
    // Mixed: part in the drawer, the rest owed.
    [{ total_amount: 1000, cash_amount: 400, payment_method: 'mixed' }, { total: 1000, cash: 400, credit: 600, check: 0 }],
    // A cash_amount above the invoice cannot be real; clamp it to the total.
    [{ total_amount: 1000, cash_amount: 5000, payment_method: 'cash' }, { total: 1000, cash: 1000, credit: 0, check: 0 }],
    // Negative and missing values must not produce negative revenue.
    [{ total_amount: 500, cash_amount: -200 }, { total: 500, cash: 0, credit: 500, check: 0 }],
    [{ total_amount: 0, cash_amount: 0 }, { total: 0, cash: 0, credit: 0, check: 0 }],
    [{}, { total: 0, cash: 0, credit: 0, check: 0 }],
  ]
  for (const [row, want] of cases) {
    const got = splitPayment(row)
    assert.deepEqual(got, want, JSON.stringify(row))
    assert.equal(got.cash + got.credit + got.check, got.total, 'parts must equal the whole')
  }
})
test('seven day breakdown groups by local day and counts invoices', () => {
  const now = new Date(2026, 10, 10, 12)
  const rows = [
    { created_at: new Date(2026, 10, 10, 9).toISOString(), total_amount: 1000, cash_amount: 1000, payment_method: 'cash' },
    { created_at: new Date(2026, 10, 10, 15).toISOString(), total_amount: 2000, cash_amount: 500, payment_method: 'mixed' },
    { created_at: new Date(2026, 10, 4, 10).toISOString(), total_amount: 300, cash_amount: 0, payment_method: 'credit' },
    // Outside the window: must be ignored entirely.
    { created_at: new Date(2026, 10, 3, 10).toISOString(), total_amount: 999, cash_amount: 999, payment_method: 'cash' },
  ]
  const days = sevenDayBreakdown(rows, now)
  assert.equal(days.length, 7)
  const last = days[6]
  assert.equal(last.date, '2026-11-10')
  assert.equal(last.value, 3000)
  assert.equal(last.cash, 1500)
  assert.equal(last.credit, 1500)
  assert.equal(last.check, 0)
  assert.equal(last.invoices, 2)
  const first = days[0]
  assert.equal(first.date, '2026-11-04')
  assert.equal(first.value, 300)
  assert.equal(first.credit, 300)
  assert.equal(first.invoices, 1)
  // An empty week is seven zeroed days, not an empty array.
  const empty = sevenDayBreakdown([], now)
  assert.equal(empty.length, 7)
  assert.equal(empty.reduce((sum, day) => sum + day.value + day.invoices, 0), 0)
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
