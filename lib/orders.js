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
