// Pure helpers for the public storefront. Kept out of the components so the
// cart maths and the tracking timeline can be tested without a browser.

import { applyOffers, lineSubtotal } from './offers'

/** 1 234 دج — grouped with a narrow space, which reads better than a comma in Arabic. */
export function formatMoney(value) {
  return `${Number(value || 0).toLocaleString('fr-DZ').replace(/\u202f|\u00a0/g, ' ')} دج`
}

/** The backend accepts 05/06/07 followed by eight digits, written however. */
export function normalizePhone(input) {
  let phone = String(input || '').replace(/[\s()+-]/g, '')
  if (/^213[5-7][0-9]{8}$/.test(phone)) phone = `0${phone.slice(3)}`
  return phone
}

export function isValidPhone(input) {
  return /^0[5-7][0-9]{8}$/.test(normalizePhone(input))
}

/** Digits a phone needs to become a wa.me target. */
export function whatsappNumber(input) {
  const phone = normalizePhone(input)
  return /^0[5-7][0-9]{8}$/.test(phone) ? `213${phone.slice(1)}` : ''
}

export function whatsappLink(phone, message) {
  const number = whatsappNumber(phone)
  const text = encodeURIComponent(message || '')
  return number ? `https://wa.me/${number}?text=${text}` : `https://wa.me/?text=${text}`
}

/**
 * get_store_products nests offers inside each product but does not repeat the
 * product id inside them; the shared pricing code matches on product_id, so we
 * stamp it back on. Products without a usable image fall back gracefully.
 */
export function normalizeProducts(products) {
  return (products || []).map(product => {
    const images = Array.isArray(product.images) ? product.images.filter(Boolean) : []
    return {
      ...product,
      image_url: product.image_url || images[0] || '',
      images: images.length ? images : (product.image_url ? [product.image_url] : []),
      variants: (product.variants || []).filter(variant => Number(variant.available) > 0),
      offers: (product.offers || []).map(offer => ({ ...offer, product_id: product.id })),
    }
  })
}

/** Every distinct category, keeping the order the products arrived in. */
export function categoriesOf(products) {
  const seen = []
  for (const product of products || []) {
    const value = (product.category || '').trim()
    if (value && !seen.includes(value)) seen.push(value)
  }
  return seen
}

/**
 * Prices the cart for display. The server recomputes everything in
 * create_order; this only has to look right and never disagree by a dinar,
 * which is why it uses the same functions as the till.
 */
export function priceCart(cart, offers) {
  const lines = (cart || []).map(item => ({
    variantId: item.variantId,
    productId: item.productId,
    qty: Number(item.qty),
    price: Number(item.unitPrice),
    originalPrice: Number(item.unitPrice),
  }))
  const priced = applyOffers(lines, offers || [])
  return priced.map((line, index) => ({
    ...cart[index],
    subtotal: lineSubtotal(line),
    offerId: line.offerId || null,
    offerKind: line.offerKind || null,
    discount: line.discount || 0,
  }))
}

export function cartCount(cart) {
  return (cart || []).reduce((sum, item) => sum + Number(item.qty || 0), 0)
}

export function cartTotal(pricedCart) {
  return (pricedCart || []).reduce((sum, item) => sum + Number(item.subtotal || 0), 0)
}

export const ORDER_STEPS = [
  { key: 'new', label: 'جديد', hint: 'وصلنا طلبك، وسنتواصل معك للتأكيد' },
  { key: 'confirmed', label: 'مؤكد', hint: 'تم تأكيد الطلب وحجز المنتجات' },
  { key: 'preparing', label: 'قيد التحضير', hint: 'نحضّر طلبك للتسليم' },
  { key: 'delivered', label: 'تم التسليم', hint: 'نتمنى أن يعجبك اختيارك' },
]

/**
 * Turns a status into a timeline. `state` is done / current / todo, so the
 * component only has to style three cases.
 */
export function timelineFor(status) {
  if (status === 'rejected' || status === 'cancelled') {
    return [{
      key: status,
      label: status === 'rejected' ? 'تم رفض الطلب' : 'تم إلغاء الطلب',
      hint: status === 'rejected' ? 'تواصل مع المتجر لمعرفة السبب' : 'تم إلغاء هذا الطلب',
      state: 'current',
    }]
  }
  const current = Math.max(ORDER_STEPS.findIndex(step => step.key === status), 0)
  return ORDER_STEPS.map((step, index) => ({
    ...step,
    state: index < current ? 'done' : index === current ? 'current' : 'todo',
  }))
}

export function statusLabel(status) {
  return ORDER_STEPS.find(step => step.key === status)?.label
    || (status === 'rejected' ? 'مرفوض' : status === 'cancelled' ? 'ملغى' : status)
}

/** A WhatsApp message the customer can send as-is. */
export function orderMessage({ storeName, cart, total, customer }) {
  const lines = (cart || []).map(item => `• ${item.productName} — ${item.size || ''} ${item.color || ''} × ${item.qty} = ${formatMoney(item.subtotal)}`)
  return [
    `مرحباً ${storeName || ''}،`,
    'أريد تأكيد هذا الطلب:',
    ...lines,
    `الإجمالي: ${formatMoney(total)}`,
    customer?.name ? `الاسم: ${customer.name}` : '',
    customer?.phone ? `الهاتف: ${customer.phone}` : '',
    customer?.fulfillment === 'pickup' ? 'الاستلام من المحل' : 'التوصيل',
  ].filter(Boolean).join('\n')
}
