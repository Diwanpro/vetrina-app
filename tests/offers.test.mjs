import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'

const code = await fs.readFile(new URL('../lib/offers.js', import.meta.url), 'utf8')
const { priceLine, applyOffers, lineSubtotal, activeOfferFor, belowFloorAllowed, offerForItem } =
  await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`)

const percent = (value) => ({ id: 'o1', variant_id: 'v1', kind: 'percent', discount_percentage: value, is_active: true })
const bundle = (qty, total) => ({ id: 'o2', variant_id: 'v1', kind: 'bundle', required_qty: qty, offer_price: total, is_active: true })
// Product-level offers carry product_id and no variant_id: they cover every size.
const productPercent = (value, product = 'p1') => ({ id: 'o3', product_id: product, variant_id: null, kind: 'percent', discount_percentage: value, is_active: true })
const productBundle = (qty, total, product = 'p1') => ({ id: 'o4', product_id: product, variant_id: null, kind: 'bundle', required_qty: qty, offer_price: total, is_active: true })

test('percentage offer discounts every unit and stays integral', () => {
  const priced = priceLine({ qty: 3, unitPrice: 2000, offer: percent(30) })
  assert.equal(priced.subtotal, 4200)
  assert.equal(priced.unitPrices[0], 1400)
  assert.equal(priced.discount, 1800)
  // 1999 * 0.7 = 1399.3 -> rounds to a whole dinar
  assert.equal(priceLine({ qty: 1, unitPrice: 1999, offer: percent(30) }).subtotal, 1399)
})

test('bundle splits evenly with the remainder on the last item', () => {
  const priced = priceLine({ qty: 3, unitPrice: 2000, offer: bundle(3, 1000) })
  assert.deepEqual(priced.unitPrices, [333, 333, 334])
  assert.equal(priced.subtotal, 1000)
})

test('bundle repeats per group and leaves leftovers at full price', () => {
  assert.equal(priceLine({ qty: 6, unitPrice: 2000, offer: bundle(3, 1000) }).subtotal, 2000)
  // 4 items = one bundle of 3 (1000) + one full-price item (2000)
  assert.equal(priceLine({ qty: 4, unitPrice: 2000, offer: bundle(3, 1000) }).subtotal, 3000)
  // 2 for 3000 mirrors the user's example: 2 x 2000 becomes 3000
  assert.equal(priceLine({ qty: 2, unitPrice: 2000, offer: bundle(2, 3000) }).subtotal, 3000)
})

test('bundle never applies before the threshold, and bad offers are ignored', () => {
  assert.equal(priceLine({ qty: 2, unitPrice: 2000, offer: bundle(3, 1000) }), null)
  assert.equal(priceLine({ qty: 3, unitPrice: 2000, offer: bundle(1, 1000) }), null)
  assert.equal(priceLine({ qty: 3, unitPrice: 2000, offer: percent(0) }), null)
  assert.equal(priceLine({ qty: 3, unitPrice: 2000, offer: percent(100) }), null)
  assert.equal(priceLine({ qty: 0, unitPrice: 2000, offer: percent(10) }), null)
  assert.equal(priceLine({ qty: 3, unitPrice: 2000, offer: null }), null)
})

test('cart re-pricing follows quantity and keeps manual prices untouched', () => {
  const cart = [
    { variantId: 'v1', qty: 2, price: 2000, originalPrice: 2000, minPrice: 1900 },
    { variantId: 'v9', qty: 1, price: 500, originalPrice: 500, minPrice: 0 },
  ]
  const offers = [bundle(2, 3000)]

  const two = applyOffers(cart, offers)
  assert.equal(two[0].subtotal, 3000)
  assert.equal(two[0].offerId, 'o2')
  assert.equal(two[1].subtotal, 500)

  // Dropping to one item cancels the bundle.
  const one = applyOffers([{ ...cart[0], qty: 1 }], offers)
  assert.equal(one[0].subtotal, 2000)
  assert.equal(one[0].offerId, null)

  const manual = applyOffers([{ ...cart[0], qty: 3, price: 1500, manualPrice: true }], offers)
  assert.equal(manual[0].subtotal, 4500)
  assert.equal(manual[0].offerId, null)
})

test('line totals and floor bypass only follow a real offer', () => {
  assert.equal(lineSubtotal({ price: 2000, qty: 3 }), 6000)
  assert.equal(lineSubtotal({ price: 333, qty: 3, subtotal: 1000 }), 1000)
  assert.equal(lineSubtotal(null), 0)
  assert.equal(belowFloorAllowed({ offerId: 'o2' }), true)
  assert.equal(belowFloorAllowed({ offerId: null }), false)
  assert.equal(activeOfferFor([{ ...bundle(2, 3000), variant_id: 'v1', is_active: false }], 'v1'), null)
  assert.equal(activeOfferFor([percent(10)], 'v1').id, 'o1')
})

test('a bundle counts one medium plus one large of the same product', () => {
  const cart = [
    { variantId: 'm', productId: 'p1', qty: 1, price: 2000, originalPrice: 2000 },
    { variantId: 'l', productId: 'p1', qty: 1, price: 2000, originalPrice: 2000 },
  ]
  const priced = applyOffers(cart, [productBundle(2, 3000)])
  assert.equal(priced[0].subtotal + priced[1].subtotal, 3000)
  assert.equal(priced[0].subtotal, 1500)
  assert.equal(priced[1].subtotal, 1500)
  for (const line of priced) assert.equal(line.offerId, 'o4')
})

test('mixed sizes split an uneven bundle exactly', () => {
  const cart = [
    { variantId: 'm', productId: 'p1', qty: 1, price: 2000, originalPrice: 2000 },
    { variantId: 'l', productId: 'p1', qty: 2, price: 2000, originalPrice: 2000 },
  ]
  const priced = applyOffers(cart, [productBundle(3, 1000)])
  // units are priced 333, 333, 334 in cart order
  assert.equal(priced[0].subtotal, 333)
  assert.equal(priced[1].subtotal, 667)
  assert.equal(priced[0].subtotal + priced[1].subtotal, 1000)
  assert.equal(lineSubtotal(priced.find(line => line.variantId === 'm')) + lineSubtotal(priced.find(line => line.variantId === 'l')), 1000)
})

test('a leftover unit stays at full price', () => {
  const cart = [
    { variantId: 'm', productId: 'p1', qty: 2, price: 2000, originalPrice: 2000 },
    { variantId: 'l', productId: 'p1', qty: 1, price: 2000, originalPrice: 2000 },
  ]
  const priced = applyOffers(cart, [productBundle(2, 3000)])
  assert.equal(priced[0].subtotal, 3000)
  assert.equal(priced[1].subtotal, 2000)
  assert.equal(priced[1].offerId, null)
})

test('different products never share a bundle', () => {
  const cart = [
    { variantId: 'a', productId: 'p1', qty: 1, price: 2000, originalPrice: 2000 },
    { variantId: 'b', productId: 'p2', qty: 1, price: 2000, originalPrice: 2000 },
  ]
  const priced = applyOffers(cart, [productBundle(2, 3000, 'p1')])
  assert.equal(priced[0].subtotal, 2000)
  assert.equal(priced[1].subtotal, 2000)
  assert.equal(priced[0].offerId, null)
})

test('product offers cover every variant and beat variant-level ones', () => {
  const cart = [{ variantId: 'v1', productId: 'p1', qty: 1, price: 2000, originalPrice: 2000 }]
  const both = [
    { ...percent(10), variant_id: 'v1', product_id: 'p1' },
    productPercent(25),
  ]
  assert.equal(offerForItem(cart[0], both).id, 'o3')
  assert.equal(applyOffers(cart, both)[0].subtotal, 1500)

  // a variant that belongs to another product is untouched
  const other = [{ variantId: 'zz', productId: 'p9', qty: 1, price: 2000, originalPrice: 2000 }]
  assert.equal(applyOffers(other, [productPercent(25)])[0].subtotal, 2000)
})

test('a manually priced line is left out of the bundle count', () => {
  const cart = [
    { variantId: 'm', productId: 'p1', qty: 1, price: 2000, originalPrice: 2000 },
    { variantId: 'l', productId: 'p1', qty: 1, price: 1200, originalPrice: 2000, manualPrice: true },
  ]
  const priced = applyOffers(cart, [productBundle(2, 3000)])
  assert.equal(priced[1].subtotal, 1200)
  assert.equal(priced[1].offerId, null)
  assert.equal(priced[0].subtotal, 2000)
})

test('an offer never raises a line above its original price', () => {
  const cart = [
    { variantId: 'm', productId: 'p1', qty: 1, price: 1000, originalPrice: 1000 },
    { variantId: 'l', productId: 'p1', qty: 1, price: 1000, originalPrice: 1000 },
  ]
  const priced = applyOffers(cart, [productBundle(2, 5000)])
  assert.equal(priced[0].subtotal, 1000)
  assert.equal(priced[1].subtotal, 1000)
})

test('every layer that re-checks the floor knows about offers', async () => {
  const localDb = await fs.readFile(new URL('../lib/local-db.js', import.meta.url), 'utf8')
  const pos = await fs.readFile(new URL('../app/dashboard/pos/page.js', import.meta.url), 'utf8')
  const sql = await fs.readFile(new URL('../supabase/migrations/202611120003_stock_movements_and_offers.sql', import.meta.url), 'utf8')

  // The local write used to reject any price under min_price, which would kill
  // every discounted sale before it ever reached the server.
  assert.match(localDb, /if \(!item\.offerId && item\.price < Number\(variant\.min_price \|\| 0\)\)/)
  assert.match(localDb, /subtotal: Number\.isSafeInteger\(item\.subtotal\) \? item\.subtotal : item\.price \* item\.qty/)

  // The POS must total lines from the offer-aware subtotal.
  assert.match(pos, /lineSubtotal\(i\)/)
  assert.doesNotMatch(pos, /s \+ i\.qty \* i\.price/)
  // Cart lines carry their product so a bundle can span sizes and colours.
  assert.match(pos, /variantId: variant\.id, productId: product\.id/)
  // Removing a line can complete or break a bundle, so it re-prices too.
  assert.match(pos, /const next = cart\.filter\(item => item\.variantId !== i\.variantId\)\s*\n\s*updateCart\(next\)/)

  // The server trusts an active offer for the tenant and variant only.
  assert.match(sql, /ALTER TABLE public\.offers ADD COLUMN IF NOT EXISTS variant_id uuid/)
  assert.match(sql, /ALTER TABLE public\.offers ADD COLUMN IF NOT EXISTS discount_percentage integer/)
  assert.match(sql, /CREATE TABLE IF NOT EXISTS public\.inventory_movements/)
  assert.match(sql, /o\.id=item\.offer_id AND o\.tenant_id=p_tenant AND o\.variant_id=item\.variant_id AND coalesce\(o\.is_active,true\)/)
  assert.match(sql, /coalesce\(subtotal,quantity\*final_price\)/)
})

test('manual stock addition requires a cost price', async () => {
  const sql = await fs.readFile(new URL('../supabase/migrations/202611120003_stock_movements_and_offers.sql', import.meta.url), 'utf8')
  assert.match(sql, /IF p_unit_cost IS NULL OR p_unit_cost < 0 THEN RAISE EXCEPTION 'سعر التكلفة مطلوب'/)
  assert.match(sql, /amount := \(\(old_qty \* coalesce\(old_cost, 0\)\) \+ \(p_quantity::numeric \* p_unit_cost\)\) \/ \(old_qty \+ p_quantity\)/)
  assert.match(sql, /VALUES \(p_tenant, p_store, p_variant, 'adjustment'/)
})

test('offers are authored per product, not per variant', async () => {
  const screen = await fs.readFile(new URL('../app/dashboard/_screens/offers.js', import.meta.url), 'utf8')
  const sql = await fs.readFile(new URL('../supabase/migrations/202611120004_product_level_offers.sql', import.meta.url), 'utf8')

  // The form no longer asks for a size or colour.
  assert.doesNotMatch(screen, /المقاس \/ اللون/)
  assert.match(screen, /p_variant: null/)
  assert.match(sql, /ALTER TABLE public\.offers ALTER COLUMN variant_id DROP NOT NULL/)
  assert.doesNotMatch(sql, /IF p_variant IS NULL OR NOT EXISTS/)
  assert.match(sql, /WHERE tenant_id = p_tenant AND product_id = p_product/)
})
