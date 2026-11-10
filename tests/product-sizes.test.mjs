import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
const code = await fs.readFile(new URL('../lib/product-sizes.js', import.meta.url), 'utf8')
const { sizesForType, emptySizeMatrix, emptySizeRow, filledSizeCells } = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`)

test('each type exposes exactly its requested sizes', () => {
  assert.deepEqual(sizesForType('clothing'), ['S', 'M', 'L', 'XL', 'XXL'])
  assert.deepEqual(sizesForType('shoes'), ['39', '40', '41', '42', '43', '44', '45'])
  assert.deepEqual(sizesForType('pants'), ['38', '40', '42', '44', '46', '48'])
})

test('variant cells use actual size strings and quantities for every type', () => {
  for (const type of ['clothing', 'shoes', 'pants']) {
    const sizes = sizesForType(type)
    const matrix = emptySizeMatrix(['أسود'], sizes)
    matrix['أسود'][sizes.at(-1)] = '3'
    assert.deepEqual(filledSizeCells(matrix, sizes), [{ color: 'أسود', size: sizes.at(-1), qty: 3 }])
    assert.deepEqual(Object.keys(emptySizeRow(sizes)), sizes)
  }
})

test('switching size type clears quantities including shared numeric sizes, keeps colors', () => {
  const matrix = emptySizeMatrix(['أسود', 'لون مخصص'], sizesForType('shoes'))
  matrix['أسود']['40'] = '5'
  const switched = emptySizeMatrix(Object.keys(matrix), sizesForType('pants'))
  assert.deepEqual(Object.keys(switched), ['أسود', 'لون مخصص'])
  assert.deepEqual(filledSizeCells(switched, sizesForType('pants')), [])
  assert.equal(switched['أسود']['40'], '')
})

test('inactive size keys are excluded and invalid quantities are rejected', () => {
  const sizes = sizesForType('shoes')
  const matrix = emptySizeMatrix(['أسود'], sizes)
  matrix['أسود'].XL = 99
  assert.deepEqual(filledSizeCells(matrix, sizes), [])
  for (const qty of ['-1', '1.5', 'abc']) {
    matrix['أسود']['39'] = qty
    assert.throws(() => filledSizeCells(matrix, sizes))
  }
})
