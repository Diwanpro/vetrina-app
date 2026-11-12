// Offer pricing shared by the POS and the offers screen.
//
// Money is integer dinars everywhere (see validMoney in lib/cash.js), so a
// bundle whose total does not divide evenly spreads the remainder over the last
// item of each group: 3 for 1000 becomes 333 + 333 + 334.

export function activeOfferFor(offers, variantId) {
  return (offers || []).find(offer => offer.is_active !== false && offer.variant_id === variantId) || null
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

/** Re-prices a whole cart whenever quantities change. */
export function applyOffers(cart, offers) {
  return (cart || []).map(item => {
    // A price the cashier typed by hand is never overwritten by an offer.
    if (item.manualPrice) {
      return { ...item, subtotal: Number(item.price) * Number(item.qty), offerId: null, offerKind: null, discount: 0 }
    }
    const offer = activeOfferFor(offers, item.variantId)
    const priced = priceLine({ qty: item.qty, unitPrice: item.originalPrice ?? item.price, offer })
    if (!priced) {
      const { subtotal, offerId, offerKind, discount, ...rest } = item
      return { ...rest, subtotal: Number(item.price) * Number(item.qty), offerId: null, offerKind: null, discount: 0 }
    }
    return {
      ...item,
      price: priced.unitPrices[0],
      subtotal: priced.subtotal,
      discount: priced.discount,
      offerId: priced.offerId,
      offerKind: priced.kind,
    }
  })
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
