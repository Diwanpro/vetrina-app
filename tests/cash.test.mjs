import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
const code = await fs.readFile(new URL('../lib/cash.js', import.meta.url), 'utf8')
const { countCash, meetsFloor, validMoney, todayRange, fetchAllRows } = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`)
test('denomination totals and empty counts', () => {
  assert.equal(countCash({}), 0)
  assert.equal(countCash({ 2000: '2', 1000: 1, 500: 3, 200: 2, 100: 1 }), 7000)
})
test('floor price allows equality, blocks discounts below floor and invalid amounts', () => {
  assert.equal(meetsFloor(1000, 1000), true)
  assert.equal(meetsFloor(999, 1000), false)
  for (const price of ['', -1, NaN, Infinity, 1.5]) assert.equal(meetsFloor(price, 0), false)
  assert.equal(meetsFloor(0, null), true)
  assert.equal(validMoney('2000'), true)
})
test('today bounds include only current local date', () => {
  const date = new Date(2026, 10, 10, 12)
  const { from, to } = todayRange(date)
  assert.equal(new Date(from).getDate(), 10)
  assert.equal(new Date(from).getHours(), 0)
  assert.equal(new Date(to).getDate(), 11)
})
test('financial pagination does not truncate at 1000 rows', async () => {
  const ranges = []
  const rows = await fetchAllRows({ range: async (from, to) => {
    ranges.push([from, to])
    return { data: Array(from === 0 ? 1000 : 3).fill({ total_amount: 10 }), error: null }
  } })
  assert.equal(rows.length, 1003)
  assert.deepEqual(ranges, [[0, 999], [1000, 1999]])
})
test('query errors propagate rather than producing misleading zeros', async () => {
  await assert.rejects(fetchAllRows({ range: async () => ({ error: new Error('denied') }) }), /denied/)
})
