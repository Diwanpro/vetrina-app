import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
const code = await fs.readFile(new URL('../lib/commercial.js', import.meta.url), 'utf8')
const { licenseBranches, canAddBranch, validateHr, validateReceipt, distribution } = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`)
test('licensing parses positive bounded branch limits, rejects wrong modes and malformed keys', () => {
  assert.equal(licenseBranches(' VTR-3-ABCD ', 'VTR'), 3)
  assert.equal(licenseBranches('UPG-2-EXTRA-2026', 'UPG'), 2)
  for (const key of ['VTR-0-X', 'VTR--2-X', 'VTR-1.5-X', 'VTR-02-X', 'VTR-2-', 'VTR-2147483648-X', 'VETRINA-LIFETIME', 'VTR-3-X ' + 'Z'.repeat(201)]) assert.throws(() => licenseBranches(key, 'VTR'))
  assert.throws(() => licenseBranches('UPG-2-X', 'VTR'))
  assert.equal(canAddBranch(1, 2), true)
  for (const limit of [null, undefined, -1, 0, '2']) assert.equal(canAddBranch(1, limit), false)
  assert.equal(canAddBranch(2, 2), false)
  assert.equal(canAddBranch(3, 2), false)
  assert.equal(canAddBranch(-1, 2), false)
  assert.equal(canAddBranch('1', 2), false)
})
test('HR details require nonblank names, enum salary type and whole nonnegative DZD', () => {
  const form = { firstName: 'أحمد', lastName: 'علي', salaryType: 'fixed', salaryAmount: '30000' }
  for (const salaryType of ['fixed', 'commission', 'daily']) assert.doesNotThrow(() => validateHr({ ...form, salaryType }))
  for (const patch of [{ salaryAmount: null }, { firstName: ' ' }, { lastName: '' }, { firstName: 'a'.repeat(101) }, { salaryType: 'bad' }, { salaryAmount: '' }, { salaryAmount: '-1' }, { salaryAmount: '1.5' }, { salaryAmount: '2147483648' }]) assert.throws(() => validateHr({ ...form, ...patch }))
})
test('receipts are optional, restricted to safe formats and capped at 5MB', () => {
  assert.doesNotThrow(() => validateReceipt(null))
  assert.doesNotThrow(() => validateReceipt({ type: 'application/pdf', size: 5242880 }))
  for (const file of [{ type: 'image/svg+xml', size: 10 }, { type: 'text/html', size: 100 }, { type: 'image/jpeg', size: 0 }, { type: 'image/png', size: 5242881 }]) assert.throws(() => validateReceipt(file))
})
test('donut distribution never renders negative profit as a positive slice or creates invalid empty slices', () => {
  const slices = distribution({ costOfGoods: 40, expenses: 20, salaries: 10, advances: 5, netProfit: -25 })
  assert.deepEqual(slices.map(s => s.value), [40, 20, 15, 0])
  assert.deepEqual(distribution({}).map(s => s.value), [0, 0, 0, 0])
})
