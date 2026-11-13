// An order line stores the product name, size and colour at the time of sale,
// and `order_items.product_id` is ON DELETE SET NULL. So a product removed from
// the catalogue leaves the line intact but unable to supply a picture — that is
// the one case the fallback below exists for.
//
// These are the only fields the orders screen needs from the embedded product:
// images and image_url, which productImage() resolves in the same precedence
// the POS and the storefront use.
export const ORDER_ITEM_FIELDS =
  'id, product_name, size, color, qty, unit_price, line_total, ' +
  'products(name, images, image_url)'

// Pure helpers for the merchant order screen. Kept out of the component so the
// transitions, the badges and the WhatsApp wording can be tested in node.

export const ORDER_TABS = [
  { key: 'new', label: 'جديد', statuses: ['new'] },
  { key: 'confirmed', label: 'مؤكد', statuses: ['confirmed'] },
  { key: 'preparing', label: 'قيد التحضير', statuses: ['preparing'] },
  { key: 'delivered', label: 'تم التسليم', statuses: ['delivered'] },
  { key: 'closed', label: 'مرفوض/ملغى', statuses: ['rejected', 'cancelled'] },
]

export const STATUS_LABELS = {
  new: 'جديد',
  confirmed: 'مؤكد',
  preparing: 'قيد التحضير',
  delivered: 'تم التسليم',
  rejected: 'مرفوض',
  cancelled: 'ملغى',
}

export function statusLabel(status) {
  return STATUS_LABELS[status] || status
}

/**
 * The server accepts exactly these moves (see update_order_status); showing a
 * button for anything else would only produce an error toast.
 */
const TRANSITIONS = {
  new: ['confirmed', 'rejected', 'cancelled'],
  confirmed: ['preparing', 'delivered', 'rejected', 'cancelled'],
  preparing: ['delivered', 'rejected', 'cancelled'],
}

const ACTION_LABELS = {
  confirmed: 'تأكيد',
  preparing: 'تحضير',
  delivered: 'تم التسليم',
  rejected: 'رفض',
  cancelled: 'إلغاء',
}

export function nextStatuses(status) {
  return (TRANSITIONS[status] || []).map(key => ({
    key,
    label: ACTION_LABELS[key],
    // Rejecting or cancelling needs a reason, and is drawn in red.
    destructive: key === 'rejected' || key === 'cancelled',
  }))
}

/** Phones are the only customer key the storefront reliably collects. */
export function phoneKey(phone) {
  const digits = String(phone || '').replace(/[^0-9]/g, '')
  return digits.length >= 8 ? digits.slice(-9) : ''
}

/**
 * Orders whose customer has been refused before. Computed over the loaded page
 * so the screen needs no extra round trip per card.
 */
export function rejectedCustomers(orders) {
  const seen = new Set()
  for (const order of orders || []) {
    if (order.status !== 'rejected' && order.status !== 'cancelled') continue
    const key = phoneKey(order.customer_phone)
    if (key) seen.add(key)
  }
  return key => Boolean(key) && seen.has(key)
}

export function itemsCount(order) {
  return (order?.order_items || []).reduce((sum, item) => sum + Number(item.qty || 0), 0)
}

export function filterByTab(orders, tabKey) {
  const tab = ORDER_TABS.find(entry => entry.key === tabKey)
  if (!tab) return orders || []
  return (orders || []).filter(order => tab.statuses.includes(order.status))
}

/** [{ key, count }] for the tab strip, so the merchant sees where the work is. */
export function tabCounts(orders) {
  return ORDER_TABS.map(tab => ({
    ...tab,
    count: (orders || []).filter(order => tab.statuses.includes(order.status)).length,
  }))
}

/**
 * One WhatsApp message per order, worded for where the order stands: a new
 * order is confirmed with the customer, a delivered one is a thank you.
 */
export function orderWhatsappMessage(order, storeName = '') {
  const name = order?.customer_name || 'عزيزي الزبون'
  const number = order?.order_number || ''
  const label = STATUS_LABELS[order?.status] || ''
  const lines = {
    new: `مرحباً ${name}، وصلنا طلبك رقم ${number} من ${storeName}. سنؤكده معك في أقرب وقت.`,
    confirmed: `مرحباً ${name}، تم تأكيد طلبك رقم ${number}. سنخبرك عندما يخرج للتوصيل.`,
    preparing: `مرحباً ${name}، طلبك رقم ${number} قيد التحضير. سنتصل بك قبل التسليم.`,
    delivered: `مرحباً ${name}، تم تسليم طلبك رقم ${number}. شكراً لثقتك في ${storeName}!`,
    rejected: `مرحباً ${name}، نعتذر عن تنفيذ طلبك رقم ${number}. تواصل معنا لمعرفة السبب.`,
    cancelled: `مرحباً ${name}، تم إلغاء طلبك رقم ${number}. تواصل معنا إن كان ذلك بالخطأ.`,
  }
  return lines[order?.status] || `مرحباً ${name}، بخصوص طلبك رقم ${number} (${label}).`
}

/** The phone must be dialable: the storefront stores it as 05/06/07xxxxxxxx. */
export function telLink(phone) {
  const digits = String(phone || '').replace(/[^0-9+]/g, '')
  return digits ? `tel:${digits}` : ''
}

export function shortDateTime(value) {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  return new Intl.DateTimeFormat('ar-DZ', {
    day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(date)
}

// ---------------------------------------------------------------- order items
// Which picture represents an order line.
//
// Name, size and colour live on the line itself, so they stay correct even when
// the product is gone. The photo does not, so it is read from the embedded
// product and may be missing. Returns '' when there is nothing usable; the
// caller draws its own placeholder rather than a broken image.
export function orderItemImage(item) {
  const product = item?.products
  if (!product) return ''
  // Deliberately a local copy of productImage() in lib/storefront.js rather
  // than an import. That module is not importable on its own under node (its
  // `./offers` import has no extension), and this file is loaded directly by
  // tests/orders-screen.test.mjs — importing it would take that suite down.
  // The precedence below is the contract both must keep: images[] wins, then
  // image_url, and an unusable entry never wins over a usable one.
  const list = Array.isArray(product.images) ? product.images : []
  const fromArray = list.find(src => typeof src === 'string' && src.trim())
  const single = typeof product.image_url === 'string' && product.image_url.trim()
  return (fromArray || (single ? product.image_url.trim() : '')) || ''
}

// "أسود · L" — the optional attributes, joined only when present.
export function orderItemVariant(item) {
  return [item?.color, item?.size].filter(Boolean).join(' · ')
}

// A short label for a line: the product name plus its attributes.
export function orderItemLabel(item) {
  const name = item?.product_name || ''
  const variant = orderItemVariant(item)
  return variant ? `${name} — ${variant}` : name
}
