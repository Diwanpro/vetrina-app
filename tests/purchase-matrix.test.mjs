import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
const code = await fs.readFile(new URL('../lib/purchase-matrix.js', import.meta.url), 'utf8')
const { matrixAxes, matrixItems, replaceProductSeries } = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`)
const variants = [
  { id: 'black-40', color: 'أسود', size: '40' },
  { id: 'black-38', color: 'أسود', size: '38' },
  { id: 'blue-40', color: 'أزرق', size: '40' },
]
test('matrix uses actual product colors and numeric sizes, not hardcoded clothing sizes', () => {
  assert.deepEqual(matrixAxes(variants), { colors: ['أسود', 'أزرق'], sizes: ['38', '40'] })
  assert.deepEqual(matrixAxes([{ size: 'XXL' }, { size: 'M' }, { size: 'S' }, { size: 'XL' }]).sizes, ['S', 'M', 'XL', 'XXL'])
  assert.deepEqual(matrixAxes([{ color: null, size: null }]), { colors: [''], sizes: [''] })
})
test('whole series becomes real variant lines and ignores blank, zero and stale cells', () => {
  assert.deepEqual(matrixItems(variants, { 'black-40': '3', 'black-38': '', 'blue-40': '2', unknown: '99' }, '500'), [
    { variant_id: 'black-40', quantity: 3, unit_cost: 500 },
    { variant_id: 'blue-40', quantity: 2, unit_cost: 500 },
  ])
  assert.deepEqual(matrixItems(variants, { 'black-40': '0', 'blue-40': '1' }, '0'), [{ variant_id: 'blue-40', quantity: 1, unit_cost: 0 }])
})
test('invalid costs, empty series and invalid quantities cannot enter invoice', () => {
  for (const cost of ['', '-1', '1.5', 'abc', '2147483648']) assert.throws(() => matrixItems(variants, { 'black-40': '1' }, cost))
  for (const quantity of ['-1', '1.5', 'abc', '2147483648']) assert.throws(() => matrixItems(variants, { 'black-40': quantity }, '100'))
  assert.throws(() => matrixItems(variants, {}, '100'))
  assert.throws(() => matrixItems(variants, { 'black-40': '0' }, '100'))
})
test('editing a product replaces its series without doubling stock and keeps other products', () => {
  const other = { variant_id: 'shoe-42', quantity: 2, unit_cost: 100 }
  const next = [{ variant_id: 'black-40', quantity: 5, unit_cost: 300 }]
  assert.deepEqual(replaceProductSeries([{ variant_id: 'black-38', quantity: 2, unit_cost: 50 }, other], variants.map(v => v.id), next), [other, ...next])
  const many = Array.from({ length: 200 }, (_, i) => ({ variant_id: `item-${i}`, quantity: 1, unit_cost: 0 }))
  assert.throws(() => replaceProductSeries(many, [], next))
})
