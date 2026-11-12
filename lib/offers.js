// Offer pricing shared by the POS and the offers screen.
//
// Money is integer dinars everywhere (see validMoney in lib/cash.js), so a
// bundle whose total does not divide evenly spreads the remainder over the last
// item of each group: 3 for 1000 becomes 333 + 333 + 334.

export function activeOfferFor(offers, variantId) {
  return (offers || []).find(offer => offer.is_active !== false && offer.variant_id === variantId) || null
}

/**
 * The offer that governs a cart line.
 *
 * Offers are authored per product, because a customer buying a medium and a
 * large of the same shirt is buying two shirts. A product-level offer therefore
 * wins over a variant-level one, which is still honoured for older rows.
 */
export function offerForItem(item, offers) {
  const active = (offers || []).filter(offer => offer.is_active !== false)
  const productOffer = active.find(offer =>
    offer.product_id && item.productId && offer.product_id === item.productId && !offer.variant_id)
  if (productOffer) return productOffer
  return active.find(offer => offer.variant_id && offer.variant_id === item.variantId) || null
}

/** Lines sharing a product share one bundle, whatever their size or colour. */
function groupKey(item) {
  return item.productId ? `product:${item.productId}` : `variant:${item.variantId}`
}

/**
 * Prices one cart line under an offer.
 * Returns null when no offer applies, otherwise:
 *   { subtotal, unitPrices, discount, offerId, kind }
 * `subtotal` is the exact amount to charge for the whole line.
 */
export function priceLine({ qty, unitPrice, offer }) {
  const quantity = Number(qty)
  const price = Number(unitPrice)
  if (!offer || !Number.isSafeInteger(quantity) || quantity <= 0) return null
  if (!Number.isSafeInteger(price) || price < 0) return null

  if (offer.kind === 'percent' || offer.discount_percentage != null) {
    const percent = Number(offer.discount_percentage || 0)
    if (!Number.isSafeInteger(percent) || percent <= 0 || percent >= 100) return null
    const discounted = Math.round((price * (100 - percent)) / 100)
    if (discounted < 0) return null
    return {
      subtotal: discounted * quantity,
      unitPrices: Array(quantity).fill(discounted),
      discount: (price - discounted) * quantity,
      offerId: offer.id,
      kind: 'percent',
    }
  }

  const required = Number(offer.required_qty || 0)
  const bundleTotal = Number(offer.offer_price || 0)
  if (!Number.isSafeInteger(required) || required < 2) return null
  if (!Number.isSafeInteger(bundleTotal) || bundleTotal <= 0) return null
  if (quantity < required) return null

  const groups = Math.floor(quantity / required)
  const rest = quantity - groups * required
  const base = Math.round(bundleTotal / required)
  const last = bundleTotal - base * (required - 1)
  if (base <= 0 || last <= 0) return null

  const unitPrices = []
  for (let group = 0; group < groups; group += 1) {
    for (let index = 0; index < required; index += 1) {
      unitPrices.push(index === required - 1 ? last : base)
    }
  }
  for (let index = 0; index < rest; index += 1) unitPrices.push(price)

  const subtotal = unitPrices.reduce((sum, value) => sum + value, 0)
  return {
    subtotal,
    unitPrices,
    discount: price * quantity - subtotal,
    offerId: offer.id,
    kind: 'bundle',
  }
}

/** The amount to charge for a cart line, honouring any offer already applied. */
export function lineSubtotal(item) {
  if (!item) return 0
  if (Number.isSafeInteger(item.subtotal)) return item.subtotal
  return Number(item.price || 0) * Number(item.qty || 0)
}

/**
 * Re-prices a whole cart whenever quantities change.
 *
 * Bundle quantities are counted across every variant of the same product: one
 * medium plus one large shirt counts as two shirts for a "2 for 3000" offer.
 * The bundle money is then spread over the lines in cart order, so the cart
 * total stays exact to the dinar.
 */
export function applyOffers(cart, offers) {
  // Re-price from the original price every time, so this stays idempotent.
  const items = (cart || []).map(item => {
    const original = Number(item.originalPrice ?? item.price)
    if (item.manualPrice) {
      return { ...item, price: Number(item.price), subtotal: Number(item.price) * Number(item.qty), offerId: null, offerKind: null, discount: 0 }
    }
    return { ...item, price: original, subtotal: original * Number(item.qty), offerId: null, offerKind: null, discount: 0 }
  })

  const bundles = new Map()

  items.forEach((item, index) => {
    if (item.manualPrice) return
    const offer = offerForItem(item, offers)
    if (!offer) return

    if (offer.kind === 'percent' || offer.discount_percentage != null) {
      const priced = priceLine({ qty: item.qty, unitPrice: Number(item.originalPrice ?? item.price), offer })
      if (priced) {
        items[index] = {
          ...item,
          price: priced.unitPrices[0],
          subtotal: priced.subtotal,
          discount: priced.discount,
          offerId: priced.offerId,
          offerKind: 'percent',
        }
      }
      return
    }

    const key = groupKey(item)
    if (!bundles.has(key)) bundles.set(key, { offer, lines: [] })
    bundles.get(key).lines.push(index)
  })

  for (const { offer, lines } of bundles.values()) {
    const required = Number(offer.required_qty || 0)
    const bundleTotal = Number(offer.offer_price || 0)
    if (!Number.isSafeInteger(required) || required < 2) continue
    if (!Number.isSafeInteger(bundleTotal) || bundleTotal <= 0) continue

    // One entry per physical unit, in cart order.
    const units = []
    for (const index of lines) {
      for (let count = 0; count < Number(items[index].qty); count += 1) units.push(index)
    }
    if (units.length < required) continue

    const base = Math.round(bundleTotal / required)
    const last = bundleTotal - base * (required - 1)
    if (base <= 0 || last <= 0) continue

    const unitPrices = []
    const groupCount = Math.floor(units.length / required)
    for (let group = 0; group < groupCount; group += 1) {
      for (let position = 0; position < required; position += 1) {
        unitPrices.push(position === required - 1 ? last : base)
      }
    }
    // Leftovers that did not fill a bundle stay at their own price.
    for (let index = unitPrices.length; index < units.length; index += 1) {
      const item = items[units[index]]
      unitPrices.push(Number(item.originalPrice ?? item.price))
    }

    const subtotals = new Map()
    unitPrices.forEach((price, index) => {
      const line = units[index]
      subtotals.set(line, (subtotals.get(line) || 0) + price)
    })

    for (const index of lines) {
      const item = items[index]
      const subtotal = subtotals.get(index) || 0
      const full = Number(item.originalPrice ?? item.price) * Number(item.qty)
      // An offer may discount, never inflate.
      if (subtotal <= 0 || subtotal >= full) continue
      items[index] = {
        ...item,
        price: Math.round(subtotal / Number(item.qty)),
        subtotal,
        discount: full - subtotal,
        offerId: offer.id,
        offerKind: 'bundle',
      }
    }
  }

  return items
}

/** True when this line may ignore the min_price floor (owner-authored offer). */
export function belowFloorAllowed(item) {
  return Boolean(item && item.offerId)
}

// Offers must survive a network drop, so the POS caches them next to the
// catalogue it already keeps offline.
const OFFERS_KEY = tenantId => `vetrina_offers_${tenantId}`

export function cacheOffers(tenantId, offers) {
  try { localStorage.setItem(OFFERS_KEY(tenantId), JSON.stringify(offers || [])) } catch {}
  return offers || []
}

export function cachedOffers(tenantId) {
  try { return JSON.parse(localStorage.getItem(OFFERS_KEY(tenantId)) || '[]') } catch { return [] }
}
