export const ARABIC_DAYS = ['الأحد', 'الإثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت']
export function localDateKey(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}
export function sevenDaySales(rows = [], now = new Date()) {
  const days = Array.from({ length: 7 }, (_, index) => {
    const date = new Date(now)
    date.setHours(0, 0, 0, 0)
    date.setDate(date.getDate() - (6 - index))
    return { date: localDateKey(date), label: ARABIC_DAYS[date.getDay()], value: 0 }
  })
  const byDate = new Map(days.map(day => [day.date, day]))
  for (const row of rows) {
    const day = byDate.get(localDateKey(new Date(row.created_at)))
    if (day) day.value += Number(row.total_amount || 0)
  }
  return days
}
// How one sale's money splits across the three payment kinds the drill-down
// reports. total_amount is the invoice total; cash_amount is what was actually
// handed over. A cheque or CCP sale is money promised, not money in the drawer,
// so it is counted as "check" rather than folded into cash — the same
// distinction the close-shift calculation makes.
export function splitPayment(row) {
  const total = Number(row.total_amount || 0)
  const cash = Math.min(Math.max(Number(row.cash_amount || 0), 0), total)
  const method = String(row.payment_method || 'cash')
  let check = 0
  if (method === 'check' || method === 'ccp') check = total
  // Whatever the invoice says and the drawer did not receive is credit,
  // whether it was sold on the book or part-paid.
  const credit = Math.max(total - cash - check, 0)
  return { total, cash, check, credit }
}

// Per-day totals for the chart's drill-down. Kept separate from sevenDaySales
// so the bar heights keep their existing, tested meaning.
export function sevenDayBreakdown(rows = [], now = new Date()) {
  const days = sevenDaySales([], now).map(day => ({
    ...day, cash: 0, credit: 0, check: 0, invoices: 0,
  }))
  const byDate = new Map(days.map(day => [day.date, day]))
  for (const row of rows) {
    const day = byDate.get(localDateKey(new Date(row.created_at)))
    if (!day) continue
    const split = splitPayment(row)
    day.value += split.total
    day.cash += split.cash
    day.check += split.check
    day.credit += split.credit
    day.invoices += 1
  }
  return days
}
export function sevenDayRange(now = new Date()) {
  const from = new Date(now)
  from.setHours(0, 0, 0, 0)
  from.setDate(from.getDate() - 6)
  const to = new Date(now)
  to.setHours(0, 0, 0, 0)
  to.setDate(to.getDate() + 1)
  return { from: from.toISOString(), to: to.toISOString() }
}
export function purchasePayload(items) {
  if (!items.length || items.length > 200) throw new Error('أضف من 1 إلى 200 بند')
  const seen = new Set()
  return items.map(item => {
    if (!item.variant_id || seen.has(item.variant_id)) throw new Error('اختر مقاساً مختلفاً لكل بند')
    seen.add(item.variant_id)
    const quantity = Number(item.quantity)
    const unit_cost = Number(item.unit_cost)
    if (item.quantity === '' || !Number.isSafeInteger(quantity) || quantity <= 0 || quantity > 2147483647 ||
      item.unit_cost === '' || !Number.isSafeInteger(unit_cost) || unit_cost < 0 || unit_cost > 2147483647) {
      throw new Error('أدخل كمية صحيحة موجبة وتكلفة صحيحة غير سالبة')
    }
    return { variant_id: item.variant_id, quantity, unit_cost }
  })
}
export function purchaseTotal(items) {
  return items.reduce((total, item) => total + Number(item.quantity || 0) * Number(item.unit_cost || 0), 0)
}
export function weightedAverage(oldQty, oldCost, qty, cost) {
  return (oldQty * oldCost + qty * cost) / (oldQty + qty)
}
export function variantBarcodes(base, count, makeId = () => crypto.randomUUID().replaceAll('-', '').slice(0, 16)) {
  const prefix = base.trim()
  if (prefix && !/^[\x21-\x7E]{1,48}$/.test(prefix)) throw new Error('الباركود يجب أن يحتوي على حروف لاتينية أو أرقام أو رموز دون مسافات (حتى 48 حرفاً)')
  return Array.from({ length: count }, (_, index) => prefix
    ? count === 1 ? prefix : `${prefix}-${String(index + 1).padStart(2, '0')}`
    : `V${makeId()}`)
}
