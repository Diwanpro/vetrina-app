import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'

const read = file => fs.readFile(new URL(`../${file}`, import.meta.url), 'utf8')
const {
  STORE_TYPES, STORE_TYPE_OPTIONS, normalizeStoreType, categoriesFor,
  categoryAllowed, storeTypeLabel, allCategoriesFor,
} = await import('../lib/store-catalog.js')
const {
  MOCK_CATALOGS, mockDashboardProducts, mockStorefrontProducts, mergeMockProducts,
  WOMENS_PRICE_RANGES,
} = await import('../lib/mock-catalog.js')
const { validateSignup, VALID_STORE_TYPES } = await import('../lib/trial.js')

// المرحلة 3: specialty is mandatory and belongs to the BRANCH, not the account.
test('three mandatory branch specialties, including «متعدد»', () => {
  assert.deepEqual(STORE_TYPE_OPTIONS.map(o => o.value), ['mens', 'womens', 'mixed'])
  assert.deepEqual(STORE_TYPE_OPTIONS.map(o => o.label), ['ملابس رجالية', 'ملابس نسائية', 'متعدد'])
  assert.equal(storeTypeLabel('mixed'), 'متعدد')
  assert.equal(normalizeStoreType('mixed'), STORE_TYPES.MIXED)
  assert.deepEqual(VALID_STORE_TYPES, ['mens', 'womens', 'mixed'])
  assert.equal(validateSignup({
    storeName: 'محلي', ownerName: 'علي', phone: '0555 12 34 56',
    password: 'secret123', storeType: 'mixed',
  }).storeType, 'mixed')
})

test('smart categories cascade from the current branch, and mixed unions both trees', () => {
  const mens = categoriesFor('mens', 'أحذية')
  const womens = categoriesFor('womens', 'أحذية')
  const mixed = categoriesFor('mixed', 'أحذية')
  assert.ok(mens.includes('سنيكرز رجالي'))
  assert.ok(!mens.includes('كعب عالي'))
  assert.ok(womens.includes('كعب عالي'))
  assert.ok(!womens.includes('سنيكرز رجالي'))
  for (const label of [...mens, ...womens]) assert.ok(mixed.includes(label))
  assert.equal(new Set(mixed).size, mixed.length, 'mixed categories must be deduplicated')
  assert.ok(categoryAllowed('mixed', 'ملابس', 'قفاطين'))
  assert.ok(categoryAllowed('mixed', 'ملابس', 'قمصان رجالية'))
  assert.ok(allCategoriesFor('mixed').length > allCategoriesFor('mens').length)
})

test("clean men's data, realistic women's prices and automatic mock loading", () => {
  const forbidden = /فستان|قفطان|بلوز|كعب|حقيبة|وشاح|نسائ|مجوهرات/
  assert.equal(MOCK_CATALOGS.mens.length, 15)
  for (const product of MOCK_CATALOGS.mens) {
    assert.doesNotMatch(product.name, forbidden)
    assert.doesNotMatch(product.description, forbidden)
    assert.match(product.image, /^\/mock\/mens\//)
  }
  assert.equal(MOCK_CATALOGS.womens.length, 10)
  for (const product of MOCK_CATALOGS.womens) {
    const [min, max] = WOMENS_PRICE_RANGES[product.productType]
    assert.ok(product.price >= min && product.price <= max)
    assert.match(product.image, /^\/mock\/womens\//)
  }
  assert.equal(MOCK_CATALOGS.mixed.length, 25)
  assert.equal(new Set(mockStorefrontProducts('mixed').map(row => row.id)).size, 25)

  const womenDashboard = mockDashboardProducts('womens', 'branch-3')
  assert.ok(womenDashboard.some(row => row.name.includes('قفطان')))
  assert.ok(!womenDashboard.some(row => /قميص رجالي|جينز مستقيم/.test(row.name)))
  const mixed = mergeMockProducts([{ id: 'real-1' }], 'mixed', 'branch-2', 'storefront')
  assert.equal(mixed[0].id, 'real-1')
  assert.equal(mixed.length, 26)
})

test('branch specialty is edited per branch in settings and the dashboard context', async () => {
  const settings = await read('app/dashboard/_screens/settings.js')
  const editor = await read('components/dashboard/BranchProfileEditor.js')
  const signup = await read('app/signup/page.js')
  const context = await read('lib/app-context.js')
  const sql = await read('supabase/migrations/202611130019_branch_specialty_themes_and_push.sql')

  assert.match(settings, /تخصص الفرع/)
  assert.match(settings, /BranchProfileEditor/)
  assert.match(settings, /engine_set_branch_profile/)
  assert.match(settings, /p_theme_key: storeSettings\.theme_key/)
  assert.match(editor, /engine_list_branch_profiles/)
  assert.match(editor, /engine_set_branch_profile/)
  assert.match(editor, /لكل فرع|كل فرع/)
  assert.match(editor, /CustomSelect/)
  assert.match(signup, /تخصص الفرع الأول/)
  assert.match(context, /currentStore\?\.store_type/)
  assert.match(context, /storeTheme/)
  assert.match(sql, /CHECK \(store_type IN \('mens', 'womens', 'mixed'\)\)/)
  assert.match(sql, /CREATE OR REPLACE FUNCTION public\.engine_set_branch_profile/)
  assert.match(sql, /CREATE OR REPLACE FUNCTION public\.engine_list_branch_profiles/)
  for (const source of [settings, editor, signup]) assert.doesNotMatch(source, /<select\b/i)
})
