import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const {
  STORE_TYPE_OPTIONS, PRODUCT_TYPES, categoriesFor, normalizeStoreType,
  categoryAllowed, storeTypeLabel,
} = await import('../lib/store-catalog.js')
const {
  MOCK_CATALOGS, WOMENS_PRICE_RANGES, mockDashboardProducts,
  mockStorefrontProducts, mergeMockProducts,
} = await import('../lib/mock-catalog.js')

test('the two mandatory store types drive the product-type tree', () => {
  assert.deepEqual(STORE_TYPE_OPTIONS.map(option => option.value), ['mens', 'womens'])
  assert.deepEqual(STORE_TYPE_OPTIONS.map(option => option.label), ['ملابس رجالية', 'ملابس نسائية'])
  assert.deepEqual([...PRODUCT_TYPES], ['ملابس', 'أحذية', 'إكسسوارات'])
  assert.equal(normalizeStoreType('other'), 'mens')
  assert.equal(storeTypeLabel('womens'), 'ملابس نسائية')
})

test('categories cascade by store type and product type', () => {
  const womensShoes = categoriesFor('womens', 'أحذية')
  for (const label of ['كعب عالي', 'صنادل', 'أحذية رياضية نسائية']) {
    assert.ok(womensShoes.includes(label))
    assert.ok(categoryAllowed('womens', 'أحذية', label))
  }
  const mensShoes = categoriesFor('mens', 'أحذية')
  for (const label of ['أحذية كلاسيك', 'سنيكرز رجالي']) assert.ok(mensShoes.includes(label))
  assert.ok(!mensShoes.includes('كعب عالي'))
  assert.ok(!categoryAllowed('mens', 'أحذية', 'كعب عالي'))
  assert.deepEqual(categoriesFor('mens', 'unknown'), [])
})

test("the clean men's mock list contains no women's products", () => {
  const forbidden = /فستان|قفطان|بلوز|كعب|حقيبة|وشاح|نسائ|مجوهرات/
  assert.equal(MOCK_CATALOGS.mens.length, 15)
  for (const product of MOCK_CATALOGS.mens) {
    assert.doesNotMatch(product.name, forbidden)
    assert.doesNotMatch(product.description, forbidden)
    assert.ok(PRODUCT_TYPES.includes(product.productType))
    assert.ok(categoriesFor('mens', product.productType).includes(product.category))
    assert.match(product.image, /^\/mock\/mens\//)
  }
})

test("women's mock products are realistic, priced in the requested DZD ranges and local", async () => {
  assert.equal(MOCK_CATALOGS.womens.length, 10)
  for (const product of MOCK_CATALOGS.womens) {
    const [min, max] = WOMENS_PRICE_RANGES[product.productType]
    assert.ok(product.price >= min && product.price <= max,
      `${product.name}: ${product.price} خارج النطاق ${min}-${max}`)
    assert.ok(product.description.length > 25)
    assert.match(product.image, /^\/mock\/womens\//)
    const file = path.join(ROOT, 'public', product.image.replace(/^\//, ''))
    await fs.access(file, fs.constants.F_OK)
  }
  for (const product of [...MOCK_CATALOGS.mens, ...MOCK_CATALOGS.womens]) {
    const file = path.join(ROOT, 'public', product.image.replace(/^\//, ''))
    await fs.access(file, fs.constants.F_OK)
  }
})

test('dashboard and storefront loaders keep real rows and deduplicate demo rows', () => {
  const dashboard = mockDashboardProducts('womens', 'store-1')
  assert.equal(dashboard.length, MOCK_CATALOGS.womens.length)
  assert.ok(dashboard.every(product => product.is_mock && product.product_variants.length))
  assert.ok(dashboard[0].product_variants[0].inventory[0].store_id === 'store-1')

  const storefront = mockStorefrontProducts('womens')
  assert.equal(storefront.length, MOCK_CATALOGS.womens.length)
  assert.ok(storefront.every(product => product.is_mock && product.variants.length && product.offers.length === 0))

  const real = [{ id: 'real-1', name: 'منتج حقيقي' }]
  const merged = mergeMockProducts(real, 'womens', 'store-1', 'dashboard')
  assert.equal(merged[0].id, 'real-1')
  assert.equal(merged.length, real.length + dashboard.length)
  const deduped = mergeMockProducts([{ id: dashboard[0].id }], 'womens', 'store-1', 'dashboard')
  assert.equal(deduped.length, dashboard.length)
})
