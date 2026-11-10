import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
const code = await fs.readFile(new URL('../lib/commercial.js', import.meta.url), 'utf8')
const { SALARY_TYPES, salaryFields, salaryPayload } = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`)
test('exactly four Arabic salary choices and conditional fields', () => {
  assert.deepEqual(Object.values(SALARY_TYPES), ['أساسي', 'عمولة', 'أساسي + عمولة', 'يومي'])
  assert.deepEqual(salaryFields('fixed'), { amount: true, commission: false })
  assert.deepEqual(salaryFields('commission'), { amount: false, commission: true })
  assert.deepEqual(salaryFields('fixed_commission'), { amount: true, commission: true })
  assert.deepEqual(salaryFields('daily'), { amount: true, commission: false })
})
test('hidden stale values cannot become fixed salary or commission', () => {
  assert.deepEqual(salaryPayload({ salaryType: 'fixed', salaryAmount: '30000', commissionPercentage: '99' }), { salaryAmount: 30000, commissionPercentage: 0 })
  assert.deepEqual(salaryPayload({ salaryType: 'commission', salaryAmount: '99999', commissionPercentage: '5.25' }), { salaryAmount: 0, commissionPercentage: 5.25 })
  assert.deepEqual(salaryPayload({ salaryType: 'fixed_commission', salaryAmount: '30000', commissionPercentage: '5' }), { salaryAmount: 30000, commissionPercentage: 5 })
  assert.deepEqual(salaryPayload({ salaryType: 'daily', salaryAmount: '1500', commissionPercentage: '50' }), { salaryAmount: 1500, commissionPercentage: 0 })
})
test('commission bounds and precision are validated without rejecting ordinary decimal floats', () => {
  for (const rate of ['0', '0.29', '5.25', '100']) assert.doesNotThrow(() => salaryPayload({ salaryType: 'commission', commissionPercentage: rate }))
  for (const rate of ['', ' ', null, undefined, '-1', '100.01', '0.001', 'NaN', 'Infinity']) assert.throws(() => salaryPayload({ salaryType: 'commission', commissionPercentage: rate }))
  assert.throws(() => salaryPayload({ salaryType: 'fixed_commission', salaryAmount: '', commissionPercentage: '5' }))
})
