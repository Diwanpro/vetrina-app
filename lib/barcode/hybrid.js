import { availableStock } from '../stock-availability.js'

export const barcodeCellKey = (color, size) => JSON.stringify([color, size])
export function validateBarcode(code) {
  if (code && !/^[!-~]{1,64}$/.test(code)) throw new Error('الباركود: من 1 إلى 64 حرفاً لاتينياً أو رقماً أو رمزاً دون مسافات')
  return code
}
export function variantStock(variant, storeId) {
  return (variant.inventory || []).filter(row => row.store_id === storeId).reduce((sum, row) => sum + availableStock(row), 0)
}
// undefined = offline catalogue. null = server authoritatively found no code.
// Registry always takes precedence over UUID fallback; old caches retain legacy support.
export function resolveHybridBarcode(products, code, tenantId, registryRow = undefined) {
  const catalog = products.filter(p => !p.tenant_id || p.tenant_id === tenantId)
  const records = registryRow === undefined
    ? catalog.flatMap(p => (p.product_barcodes || []).map(b => ({ ...b, product_id: p.id })))
    : registryRow ? [registryRow] : []
  const matches = records.filter(b => b.barcode === code && (!b.tenant_id || b.tenant_id === tenantId))
  if (matches.length > 1) throw new Error('باركود ملتبس؛ حدّث الكتالوج')
  if (matches.length) {
    const row = matches[0]
    const product = catalog.find(p => p.id === row.product_id)
    if (!product) throw new Error('المنتج غير متاح في كتالوج هذا الفرع؛ حدّث الكتالوج')
    if (row.barcode_type === 'model') return { type: 'model', product }
    const variant = product.product_variants?.find(v => v.id === row.variant_id)
    if (!variant || row.barcode_type !== 'variant') throw new Error('تركيبة غير متاحة في هذا الفرع؛ حدّث الكتالوج')
    return { type: 'variant', product, variant }
  }
  for (const product of catalog) {
    const variant = product.product_variants?.find(v => v.id === code || (
      registryRow === undefined && !Object.hasOwn(product, 'product_barcodes') && v.barcode === code
    ))
    if (variant) return { type: 'variant', product, variant }
  }
  throw new Error('الباركود غير موجود في كتالوج هذا الفرع. حدّث الكتالوج أثناء الاتصال.')
}
export function productBarcodePayload(cells, modelCode, variantCodes) {
  const model = validateBarcode(String(modelCode || '').trim())
  const seen = new Set(model ? [model] : [])
  const variants = cells.map(cell => {
    const code = validateBarcode(String(variantCodes[barcodeCellKey(cell.color, cell.size)] || '').trim())
    if (code && seen.has(code)) throw new Error('باركود مكرر بين الموديل والتركيبات')
    if (code) seen.add(code)
    return { color: cell.color, size: cell.size, quantity: cell.qty, barcodes: code ? [{ barcode: code, source: 'manual' }] : [] }
  })
  return { variants, modelBarcodes: model ? [{ barcode: model, source: 'manual' }] : [] }
}
export function barcodeLabels(product, variants, records, mode) {
  const models = records.filter(b => b.product_id === product.id && b.barcode_type === 'model')
    .map(b => ({ id: b.id, barcode: b.barcode, name: product.name, detail: 'باركود الموديل' }))
  const labels = variants.flatMap(v => {
    const codes = records.filter(b => b.product_id === product.id && b.variant_id === v.id && b.barcode_type === 'variant')
    // UUID labels remain valid for genuinely unregistered old variants only.
    return (codes.length ? codes : [{ id: `uuid-${v.id}`, barcode: v.id }]).map(b => ({ id: b.id, barcode: b.barcode, name: product.name, detail: `${v.color || 'بدون لون'} / ${v.size || 'موحّد'}` }))
  })
  return mode === 'model' ? models : mode === 'variant' ? labels : [...models, ...labels]
}
