export const STOCK_RESERVED_MESSAGE = 'الكمية المتاحة غير كافية (يوجد حجز لطلبات أخرى)'
// Legacy cached catalogues without reservation data must be refreshed online.
export function availableStock(stock) {
  if (!stock || !Object.hasOwn(stock, 'reserved_qty')) return 0
  const quantity = Number(stock.quantity)
  const reserved = Number(stock.reserved_qty ?? 0)
  if (!Number.isSafeInteger(quantity) || !Number.isSafeInteger(reserved) || reserved < 0) return 0
  return Math.max(0, quantity - reserved)
}
