import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
const code = await fs.readFile(new URL('../lib/access.js', import.meta.url), 'utf8')
const { selectScope, scopeQuery, routeAllowed, subscriptionLocked, csvText, isNetworkError } = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`)
const stores = [{ id: 'branch-a' }, { id: 'branch-b' }]
const profile = { tenantId: 'tenant', role: 'employee', assignedStoreId: 'branch-a' }
test('manager/employee ignore a tampered owner branch selection and require assignment', () => {
  for (const role of ['employee', 'manager']) {
    assert.deepEqual(selectScope({ ...profile, role }, stores, 'all'), { storeId: 'branch-a', storeIds: ['branch-a'], allBranches: false })
    assert.equal(selectScope({ ...profile, role }, stores, 'branch-b').storeId, 'branch-a')
    assert.throws(() => selectScope({ ...profile, role, assignedStoreId: null }, stores, 'branch-b'))
  }
})
test('owner supports every tenant branch with no arbitrary cap; foreign selection ignored', () => {
  const many = Array.from({ length: 5000 }, (_, i) => ({ id: `branch-${i}` }))
  assert.equal(selectScope({ ...profile, role: 'owner' }, many, 'all').storeIds.length, 5000)
  assert.equal(selectScope({ ...profile, role: 'owner' }, stores, 'foreign').storeId, 'branch-a')
})
test('scope filters never fall back to an unscoped query and use a tenant join for all branches', () => {
  const calls = []
  const query = { eq: (...args) => { calls.push(args); return query } }
  const ctx = { ...profile, ...selectScope(profile, stores, 'all') }
  scopeQuery(query, ctx)
  assert.deepEqual(calls.pop(), ['store_id', 'branch-a'])
  assert.throws(() => scopeQuery(query, { ...ctx, storeIds: [] }))
  assert.throws(() => scopeQuery(query, { ...ctx, storeId: 'branch-b' }))
  const owner = { ...profile, role: 'owner', ...selectScope({ ...profile, role: 'owner' }, stores, 'all') }
  scopeQuery(query, owner)
  assert.deepEqual(calls.pop(), ['stores.tenant_id', 'tenant'])
})
test('role routes block direct navigation as well as hidden nav items', () => {
  assert.equal(routeAllowed('employee', '/dashboard/transfers'), false)
  assert.equal(routeAllowed('manager', '/dashboard/transfers'), false)
  assert.equal(routeAllowed('owner', '/dashboard/transfers'), true)
  assert.equal(routeAllowed('employee', '/dashboard/products/barcodes'), false)
  assert.equal(routeAllowed('employee', '/dashboard/pos'), true)
})
test('lock uses expired AND inactive, including correct boundary/null behavior', () => {
  const now = new Date('2026-11-10T12:00:00Z')
  assert.equal(subscriptionLocked({ is_active: false, subscription_end_date: '2026-11-09' }, now), true)
  assert.equal(subscriptionLocked({ is_active: true, subscription_end_date: '2026-11-09' }, now), false)
  assert.equal(subscriptionLocked({ is_active: false, subscription_end_date: '2026-11-11' }, now), false)
  assert.equal(subscriptionLocked({ is_active: false, subscription_end_date: null }, now), false)
})
test('CSV supports Arabic, quotes, multiline fields and neutralizes spreadsheet formulas', () => {
  const csv = csvText([{ key: 'name', label: 'المنتج' }], [{ name: 'قميص "قطن"\nأبيض' }, { name: '=IMPORTXML("bad")' }, { name: ' @SUM(A1)' }])
  assert.ok(csv.startsWith('\uFEFF'))
  assert.ok(csv.includes('قميص ""قطن""\nأبيض'))
  assert.ok(csv.includes("'=IMPORTXML"))
  assert.ok(csv.includes("' @SUM"))
})
test('only network failures permit a cached profile, not authorization errors', () => {
  assert.equal(isNetworkError({ message: 'Failed to fetch' }), true)
  assert.equal(isNetworkError({ name: 'AbortError' }), true)
  assert.equal(isNetworkError({ message: 'Invalid JWT' }), false)
  assert.equal(isNetworkError({ message: 'permission denied' }), false)
})
