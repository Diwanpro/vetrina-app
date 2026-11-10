// The matrix is built from real variants, never hardcoded clothing sizes.
const sizeOrder = ['XS', 'S', 'M', 'L', 'XL', 'XXL', 'XXXL']
export function matrixAxes(variants) {
  const colors = [...new Set(variants.map(variant => variant.color ?? ''))]
  const sizes = [...new Set(variants.map(variant => variant.size ?? ''))].sort((a, b) => {
    const ai = sizeOrder.indexOf(a), bi = sizeOrder.indexOf(b)
    if (ai >= 0 && bi >= 0) return ai - bi
    return a.localeCompare(b, 'ar', { numeric: true })
  })
  return { colors, sizes }
}
export function matrixItems(variants, quantities, unitCost) {
  if (unitCost === '' || !Number.isSafeInteger(Number(unitCost)) || Number(unitCost) < 0 || Number(unitCost) > 2147483647) {
    throw new Error('أدخل تكلفة وحدة صحيحة غير سالبة')
  }
  const items = []
  for (const variant of variants) {
    const value = quantities[variant.id] ?? ''
    if (value === '') continue
    const quantity = Number(value)
    if (!Number.isSafeInteger(quantity) || quantity < 0 || quantity > 2147483647) throw new Error('الكميات يجب أن تكون أعداداً صحيحة غير سالبة')
    if (quantity > 0) items.push({ variant_id: variant.id, quantity, unit_cost: Number(unitCost) })
  }
  if (!items.length) throw new Error('أدخل كمية واحدة على الأقل في الجدول')
  return items
}
// A product has one editable series per invoice. Reopening replaces that series
// rather than silently adding a duplicate or doubling its quantities.
export function replaceProductSeries(items, productVariantIds, nextItems) {
  const ids = new Set(productVariantIds)
  const next = [...items.filter(item => !ids.has(item.variant_id)), ...nextItems]
  if (next.length > 200) throw new Error('يمكن أن تحتوي الفاتورة على 200 مقاس كحد أقصى')
  return next
}
