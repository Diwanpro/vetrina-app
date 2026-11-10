import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
const load = async path => import(`data:text/javascript;base64,${Buffer.from(await fs.readFile(new URL(path, import.meta.url), 'utf8')).toString('base64')}`)
const { accountingRange } = await load('../lib/accounting.js')
const { routeAllowed } = await load('../lib/access.js')
test('month/year/all have half-open local calendar bounds and handle year rollover', () => {
  const now = new Date(2026, 11, 15, 12)
  assert.deepEqual(accountingRange('month', now), { from: new Date(2026, 11, 1).toISOString(), to: new Date(2027, 0, 1).toISOString() })
  assert.deepEqual(accountingRange('year', now), { from: new Date(2026, 0, 1).toISOString(), to: new Date(2027, 0, 1).toISOString() })
  assert.deepEqual(accountingRange('all', now), { from: null, to: now.toISOString() })
  assert.throws(() => accountingRange('bad', now))
})
test('users/accounting direct routes and descendants are owner-only', () => {
  for (const path of ['/dashboard/users', '/dashboard/users/create', '/dashboard/accounting']) {
    assert.equal(routeAllowed('owner', path), true)
    for (const role of ['manager', 'employee', '', null]) assert.equal(routeAllowed(role, path), false)
  }
})
