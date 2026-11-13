import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'

// lib/storefront.js imports the shared pricing module, which a data: URL cannot
// resolve. Inlining the two files keeps the test dependency-free, exactly like
// the other suites here.
const offersSource = await fs.readFile(new URL('../lib/offers.js', import.meta.url), 'utf8')
const storefrontSource = (await fs.readFile(new URL('../lib/storefront.js', import.meta.url), 'utf8'))
  .replace(/^import .*$/m, '')
const code = `${offersSource}\n${storefrontSource}`
const {
  formatMoney, normalizePhone, isValidPhone, whatsappNumber, whatsappLink,
  normalizeProducts, categoriesOf, priceCart, cartCount, cartTotal,
  timelineFor, statusLabel, orderMessage, offerBadge, stockHint, isSoldOut,
  productImage, hasActiveOffer, offersOf, productsForTab,
} = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`)

const product = (overrides = {}) => ({
  id: 'p1', name: 'قميص', base_price: 2000, images: ['a.jpg'], image_url: '',
  category: 'ملابس',
  variants: [{ id: 'm', color: 'أبيض', size: 'M', available: 3 }, { id: 'l', color: 'أبيض', size: 'L', available: 2 }],
  offers: [], ...overrides,
})

test('money is grouped with commas and keeps the dinar suffix', () => {
  // No thin-space grouping: it reads as two numbers next to a currency in RTL.
  assert.ok(formatMoney(0).includes('0 دج'))
  assert.ok(formatMoney(1234).includes('1,234 دج'))
  assert.ok(formatMoney(3000).includes('3,000 دج'))
  assert.ok(formatMoney(1000000).includes('1,000,000 دج'))
  assert.doesNotMatch(formatMoney(3800), /3\s800/)
})

test('Algerian phone numbers are accepted however they are written', () => {
  for (const value of ['0555123456', '0555 12 34 56', '+213 555 12 34 56', '00213555123456'.slice(2)]) {
    assert.equal(isValidPhone(value), true, value)
  }
  for (const value of ['', '12345', '055512345', '0455123456', '05551234567']) {
    assert.equal(isValidPhone(value), false, value)
  }
  assert.equal(normalizePhone('+213 555 12 34 56'), '0555123456')
  assert.equal(whatsappNumber('0555123456'), '213555123456')
  assert.equal(whatsappNumber('123'), '')
  assert.match(whatsappLink('0555123456', 'مرحبا'), /^https:\/\/wa\.me\/213555123456\?text=/)
})

test('products are normalised for the storefront', () => {
  const [ready] = normalizeProducts([product({ offers: [{ id: 'o1', kind: 'bundle', required_qty: 2, offer_price: 3000 }] })])
  assert.equal(ready.image_url, 'a.jpg')
  assert.equal(ready.offers[0].product_id, 'p1')
  assert.equal(ready.variants.length, 2)

  // Sold-out variants are kept so the picker can grey them out; the count is
  // clamped so a negative reservation can never look like stock.
  const [filtered] = normalizeProducts([product({ variants: [{ id: 'x', size: 'S', available: -2 }] })])
  assert.equal(filtered.variants.length, 1)
  assert.equal(filtered.variants[0].available, 0)

  // A product with no image at all must still render.
  const [bare] = normalizeProducts([product({ images: [], image_url: '' })])
  assert.equal(bare.image_url, '')
})

test('categories keep their first-seen order and drop blanks', () => {
  const list = normalizeProducts([
    product({ id: '1', category: 'ملابس' }),
    product({ id: '2', category: 'أحذية' }),
    product({ id: '3', category: 'ملابس' }),
    product({ id: '4', category: '' }),
  ])
  assert.deepEqual(categoriesOf(list), ['ملابس', 'أحذية'])
})

test('cart pricing matches the till, including cross-size bundles', () => {
  const offers = [{ id: 'o1', product_id: 'p1', kind: 'bundle', required_qty: 2, offer_price: 3000 }]
  const cart = [
    { variantId: 'm', productId: 'p1', productName: 'قميص', qty: 1, unitPrice: 2000, max: 3 },
    { variantId: 'l', productId: 'p1', productName: 'قميص', qty: 1, unitPrice: 2000, max: 2 },
  ]
  const priced = priceCart(cart, offers)
  assert.equal(cartCount(cart), 2)
  assert.equal(cartTotal(priced), 3000)
  assert.equal(priced[0].subtotal + priced[1].subtotal, 3000)
  assert.ok(priced.every(line => line.offerId === 'o1'))

  // One shirt alone stays at full price.
  const single = priceCart([cart[0]], offers)
  assert.equal(cartTotal(single), 2000)
  assert.equal(single[0].offerId, null)
})

test('percentage offers discount the cart without touching the raw cart', () => {
  const cart = [{ variantId: 'm', productId: 'p1', productName: 'قميص', qty: 2, unitPrice: 2000, max: 3 }]
  const offers = [{ id: 'o2', product_id: 'p1', kind: 'percent', discount_percentage: 25 }]
  const priced = priceCart(cart, offers)
  assert.equal(cartTotal(priced), 3000)
  assert.equal(cart[0].qty, 2, 'the source cart must not be mutated')
  assert.equal(priceCart(cart, [])[0].subtotal, 4000)
})

test('the timeline reflects every status', () => {
  const fresh = timelineFor('new')
  assert.equal(fresh.length, 4)
  assert.deepEqual(fresh.map(step => step.state), ['current', 'todo', 'todo', 'todo'])

  const preparing = timelineFor('preparing')
  assert.deepEqual(preparing.map(step => step.state), ['done', 'done', 'current', 'todo'])

  const delivered = timelineFor('delivered')
  assert.deepEqual(delivered.map(step => step.state), ['done', 'done', 'done', 'current'])

  for (const terminal of ['rejected', 'cancelled']) {
    const steps = timelineFor(terminal)
    assert.equal(steps.length, 1)
    assert.equal(steps[0].state, 'current')
  }
  assert.equal(statusLabel('preparing'), 'قيد التحضير')
  assert.equal(statusLabel('rejected'), 'مرفوض')
})

test('the WhatsApp message names the items, the total and the handover', () => {
  const message = orderMessage({
    storeName: 'بوتيك',
    cart: [{ productName: 'قميص', size: 'M', color: 'أبيض', qty: 2, subtotal: 3000 }],
    total: 3000,
    customer: { name: 'علي', phone: '0555123456', fulfillment: 'pickup' },
  })
  assert.match(message, /بوتيك/)
  assert.match(message, /قميص/)
  assert.match(message, /3,000 دج/)
  assert.match(message, /الاستلام من المحل/)
})

test('the storefront only ever talks to the public RPCs', async () => {
  const files = [
    '../app/s/[slug]/page.js',
    '../app/s/[slug]/track/[token]/page.js',
    '../components/store/Storefront.js',
    '../components/store/CartSheet.js',
    '../components/store/TrackOrder.js',
    '../components/store/ProductSheet.js',
    '../components/store/StoreHeader.js',
    '../lib/public-store.js',
  ]
  const sources = await Promise.all(files.map(file => fs.readFile(new URL(file, import.meta.url), 'utf8')))
  const all = sources.join('\n')

  // No table access, no service key: the browser holds only the anon key and
  // the three storefront functions, which is what Phase A closed the tables behind.
  for (const source of sources) {
    // `.from('table')` is a table query; Array.from is not.
    assert.doesNotMatch(source, /\.from\(\s*['"]/, 'storefront must not query tables directly')
    assert.doesNotMatch(source, /service_role|SERVICE_ROLE/i)
  }

  const used = [...new Set([...all.matchAll(/rpc\('([a-z_]+)'/g)].map(match => match[1]))].sort()
  assert.deepEqual(used, ['create_order', 'get_order_by_token', 'get_store_by_slug', 'get_store_products'])
})

test('the public pages resolve their dynamic segments', async () => {
  const store = await fs.readFile(new URL('../app/s/[slug]/page.js', import.meta.url), 'utf8')
  const track = await fs.readFile(new URL('../app/s/[slug]/track/[token]/page.js', import.meta.url), 'utf8')
  assert.match(store, /await params/)
  assert.match(track, /await params/)
  // Both live outside /dashboard, so the shell and its auth gate do not apply.
  assert.doesNotMatch(store, /DashboardShell/)
  assert.doesNotMatch(track, /DashboardShell/)
})

test('the card badge names the offer without a wall of text', () => {
  assert.equal(offerBadge({ kind: 'percent', discount_percentage: 20 }), '−20%')
  const plain = text => String(text).replace(/[\u2066-\u2069]/g, '')
  assert.equal(plain(offerBadge({ kind: 'bundle', required_qty: 2, offer_price: 3000 })), '2 بـ 3,000 دج')
  assert.equal(plain(offerBadge({ kind: 'bundle', required_qty: 2, offer_price: 3000, name: 'عرض' })), '2 بـ 3,000 دج')
  assert.equal(offerBadge(null), '')
  assert.equal(offerBadge({ kind: 'percent', discount_percentage: 0, name: 'عرض الصيف' }), 'عرض الصيف')
})

test('stock is only spelled out when it is about to run out', () => {
  assert.equal(stockHint(5), '')
  assert.equal(stockHint(3), '')
  assert.equal(stockHint(2), 'بقي 2')
  assert.equal(stockHint(1), 'بقي 1')
  assert.equal(stockHint(0), '')
  assert.equal(isSoldOut({ variants: [{ available: 0 }, { available: 2 }] }), false)
  assert.equal(isSoldOut({ variants: [{ available: 0 }] }), true)
  assert.equal(isSoldOut({}), true)
})


// --------------------------------------------------------------- productImage
// One helper decides which photo represents a product, so the POS and the
// public store cannot disagree again. It must prefer the array, skip unusable
// entries, and fall back to the single-url column.
test('productImage prefers the images array and falls back to image_url', () => {
  assert.equal(productImage({ images: ['a.jpg'], image_url: 'b.jpg' }), 'a.jpg')
  assert.equal(productImage({ images: [], image_url: 'b.jpg' }), 'b.jpg')
  assert.equal(productImage({ image_url: 'b.jpg' }), 'b.jpg')
})

test('productImage skips null, blank and non-string array entries', () => {
  assert.equal(productImage({ images: [null, 'c.jpg'] }), 'c.jpg')
  assert.equal(productImage({ images: ['   '], image_url: 'd.jpg' }), 'd.jpg')
  assert.equal(productImage({ images: [null] }), '')
  // The exact shape of the old POS bug: images[0] was null and image_url had
  // the real photo, but the first element was returned regardless.
  assert.equal(productImage({ images: [null], image_url: 'real.jpg' }), 'real.jpg')
})

test('productImage returns an empty string instead of throwing on junk', () => {
  assert.equal(productImage(null), '')
  assert.equal(productImage(undefined), '')
  assert.equal(productImage({}), '')
  assert.equal(productImage({ images: 'not-an-array', image_url: '' }), '')
  assert.equal(productImage({ image_url: '  e.jpg  ' }), 'e.jpg')
})

test('normalizeProducts resolves image_url from whichever column holds a photo', () => {
  const [fromArray, fromUrl, fromNeither] = normalizeProducts([
    { id: 'a', images: ['x.jpg'], image_url: '' },
    { id: 'b', images: [], image_url: 'y.jpg' },
    { id: 'c', images: [], image_url: '' },
  ])
  assert.equal(fromArray.image_url, 'x.jpg')
  assert.equal(fromUrl.image_url, 'y.jpg')
  assert.equal(fromNeither.image_url, '')
})

// ------------------------------------------------ storefront tabs (الكل/عروض/إطلالات)

test('offersOf keeps only products whose card would actually show a badge', () => {
  // An offer row with neither a percentage nor a real bundle price renders no
  // badge, so it must not put the product under عروض either — the tab and the
  // grid have to tell the shopper the same story.
  const badgeOnly = { ...product({ id: 'a' }), offers: [{ kind: 'percent', discount_percentage: 20 }] }
  const bundle = { ...product({ id: 'b' }), offers: [{ kind: 'bundle', required_qty: 3, offer_price: 5000 }] }
  const empty = { ...product({ id: 'c' }), offers: [{ kind: 'percent', discount_percentage: 0 }] }
  const none = { ...product({ id: 'd' }), offers: [] }
  const named = { ...product({ id: 'e' }), offers: [{ kind: 'bundle', name: 'عرض خاص' }] }

  assert.equal(hasActiveOffer(badgeOnly), true)
  assert.equal(hasActiveOffer(bundle), true)
  assert.equal(hasActiveOffer(named), true)
  assert.equal(hasActiveOffer(empty), false)
  assert.equal(hasActiveOffer(none), false)
  assert.deepEqual(offersOf([badgeOnly, bundle, empty, none, named]).map(p => p.id), ['a', 'b', 'e'])
})

test('offersOf drops a sold-out product, which the card marks نفدت الكمية', () => {
  const live = { ...product({ id: 'live' }), offers: [{ kind: 'percent', discount_percentage: 10 }] }
  const gone = {
    ...product({ id: 'gone' }),
    offers: [{ kind: 'percent', discount_percentage: 10 }],
    variants: [{ id: 'v', available: 0 }],
  }
  assert.deepEqual(offersOf([live, gone]).map(p => p.id), ['live'])
})

test('productsForTab resolves كل / عروض / a category name', () => {
  const shirt = { ...product({ id: 's' }), category: 'ملابس' }
  const jean = { ...product({ id: 'j', name: 'جينز' }), category: 'ملابس', offers: [{ kind: 'percent', discount_percentage: 15 }] }
  const watch = { ...product({ id: 'w', name: 'ساعة' }), category: 'إكسسوارات' }
  const all = [shirt, jean, watch]

  assert.deepEqual(productsForTab(all, 'all').map(p => p.id), ['s', 'j', 'w'])
  assert.deepEqual(productsForTab(all, '').map(p => p.id), ['s', 'j', 'w'])
  assert.deepEqual(productsForTab(all, 'offers').map(p => p.id), ['j'])
  assert.deepEqual(productsForTab(all, 'ملابس').map(p => p.id), ['s', 'j'])
  assert.deepEqual(productsForTab(all, 'لا يوجد').map(p => p.id), [])
  // A tab key must never be confused with a category literally named عروض.
  assert.deepEqual(productsForTab([{ ...product({ id: 'x' }), category: 'عروض' }], 'offers').map(p => p.id), [])
})

test('the storefront renders tabs and reads images through productImage()', async () => {
  const ui = await fs.readFile(new URL('../components/store/Storefront.js', import.meta.url), 'utf8')
  // The rail and all three fixed tabs exist.
  for (const label of ['الكل', 'عروض', 'إطلالات']) {
    assert.ok(ui.includes(`'${label}'`) || ui.includes(`label: '${label}'`), `missing tab ${label}`)
  }
  assert.match(ui, /className="sf-rail mt-4 flex gap-2 overflow-x-auto px-4 pb-1"/)
  // Lists come from the tested helpers, not from inline filtering.
  assert.match(ui, /productsForTab\(products, tab\)/)
  assert.match(ui, /offersOf\(products\)/)
  // A plain <img>, never next/image: the URLs are arbitrary Unsplash CDN links
  // and next/image would require each host in remotePatterns.
  assert.doesNotMatch(ui, /from 'next\/image'/)
  assert.match(ui, /<img src=\{productImage\(/)
  assert.match(ui, /productImage\(look\)/)
})
