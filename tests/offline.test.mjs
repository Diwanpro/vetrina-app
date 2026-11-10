import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import 'fake-indexeddb/auto'
const code = await fs.readFile(new URL('../lib/local-db.js', import.meta.url), 'utf8')
const { saveCatalog, localGet, localRows, localPut, persistLocalSale, catalogKey, pendingRows } = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`)
function fixture() {
  const ctx = { user: { id: crypto.randomUUID() }, staffId: crypto.randomUUID(), tenantId: 'tenant', storeId: 'branch-a', storeIds: ['branch-a'], allBranches: false }
  const products = [{ id: 'product', product_variants: [{ id: 'variant', min_price: 100, inventory: [{ store_id: 'branch-a', quantity: 5 }] }] }]
  const cart = [{ variantId: 'variant', qty: 2, price: 150, originalPrice: 200, name: 'قميص' }]
  return { ctx, products, cart }
}
test('sale and stock reservation persist atomically and retain their original author/branch', async () => {
  const { ctx, products, cart } = fixture()
  await saveCatalog(ctx, products)
  const row = await persistLocalSale(ctx, cart, 'cash')
  assert.equal(row.status, 'pending'); assert.equal(row.auth_id, ctx.user.id)
  assert.equal(row.staff_id, ctx.staffId); assert.equal(row.store_id, ctx.storeId)
  assert.equal(row.total_amount, 300)
  const cached = await localGet(catalogKey(ctx))
  assert.equal(cached[0].product_variants[0].inventory[0].quantity, 3)
  assert.equal((await pendingRows(ctx)).length, 1)
  assert.equal((await pendingRows({ ...ctx, user: { id: 'different-user' } })).length, 0)
})
test('failed transactions do not lose stock or create a partial receipt', async () => {
  const { ctx, products, cart } = fixture()
  await saveCatalog(ctx, products)
  await assert.rejects(persistLocalSale(ctx, [{ ...cart[0], qty: 6 }], 'cash'), /المخزون/)
  await assert.rejects(persistLocalSale(ctx, [{ ...cart[0], price: 99 }], 'cash'))
  await assert.rejects(persistLocalSale(ctx, cart, 'invalid'))
  assert.equal((await pendingRows(ctx)).length, 0)
  assert.equal((await localGet(catalogKey(ctx)))[0].product_variants[0].inventory[0].quantity, 5)
})
test('concurrent tabs cannot both reserve more than cached stock', async () => {
  const { ctx, products, cart } = fixture()
  await saveCatalog(ctx, products)
  const results = await Promise.allSettled([persistLocalSale(ctx, [{ ...cart[0], qty: 3 }], 'cash'), persistLocalSale(ctx, [{ ...cart[0], qty: 3 }], 'cash')])
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1)
  assert.equal((await pendingRows(ctx)).length, 1)
  assert.equal((await localGet(catalogKey(ctx)))[0].product_variants[0].inventory[0].quantity, 2)
})
test('refresh subtracts pending receipts; errors stay visible, successful acknowledgments stop reserving', async () => {
  const { ctx, products, cart } = fixture()
  await saveCatalog(ctx, products)
  const row = await persistLocalSale(ctx, cart, 'cash')
  await localPut({ ...row, status: 'error', error: 'stock conflict' })
  assert.equal((await saveCatalog(ctx, products))[0].product_variants[0].inventory[0].quantity, 3)
  assert.equal((await pendingRows(ctx))[0].error, 'stock conflict')
  await localPut({ ...row, status: 'synced', synced_at: new Date().toISOString() })
  const serverSnapshot = structuredClone(products)
  serverSnapshot[0].product_variants[0].inventory[0].quantity = 3
  assert.equal((await saveCatalog(ctx, serverSnapshot))[0].product_variants[0].inventory[0].quantity, 3)
  assert.equal((await pendingRows(ctx)).length, 0)
  assert.ok((await localRows()).some(value => value.local_id === row.local_id && value.status === 'synced'))
})
test('catalogs and queues remain isolated across tenant, staff, branch and user switches', async () => {
  const { ctx, products, cart } = fixture()
  await saveCatalog(ctx, products); await persistLocalSale(ctx, cart, 'cash')
  for (const change of [{ tenantId: 'other-tenant' }, { staffId: 'other-staff' }, { storeId: 'branch-b' }, { user: { id: 'other-user' } }]) {
    assert.equal((await pendingRows({ ...ctx, ...change })).length, 0)
  }
  assert.equal(await localGet(catalogKey({ ...ctx, storeId: 'branch-b' })), undefined)
})
