'use client'

import { sizeLabel } from '@/lib/product-attributes'
import { useState } from 'react'
import CustomSelect from '@/components/ui/CustomSelect'
import { Modal, primaryClass } from './EngineUI'
import { variantStock } from '@/lib/barcode/hybrid'

// No default selection, even when exactly one variant is available.
export default function BarcodeModelPicker({ product, storeId, busy, error, onClose, onConfirm }) {
  const [color, setColor] = useState('')
  const [variantId, setVariantId] = useState('')
  const variants = (product.product_variants || []).filter(v => variantStock(v, storeId) > 0)
  const colors = [...new Set(variants.map(v => v.color || 'بدون لون'))]
  return <Modal title={`اختيار تركيبة · ${product.name}`} onClose={onClose} busy={busy}>
    <p className="mb-4 text-sm text-neutral-400">تم مسح باركود الموديل. اختر اللون والمقاس ثم أكّد الإضافة، حتى لو توفرت تركيبة واحدة.</p>
    <div className="space-y-4">
      <CustomSelect label="اللون" aria-label="لون الموديل" value={color} disabled={busy} placeholder="اختر اللون" options={colors.map(value => ({ value, label: value }))} onChange={value => { setColor(value); setVariantId('') }} />
      <CustomSelect label="المقاس" aria-label="مقاس الموديل" value={variantId} disabled={busy || !color} placeholder="اختر المقاس" options={variants.filter(v => (v.color || 'بدون لون') === color).map(v => ({ value: v.id, label: `${sizeLabel(v.size)} · المتاح ${variantStock(v, storeId)}` }))} onChange={setVariantId} />
      {error && <p role="alert" className="text-sm text-red-300">{error}</p>}
      {!variants.length && <p role="alert" className="text-sm text-amber-300">لا توجد كمية متاحة لهذا الموديل في الفرع.</p>}
      <button type="button" disabled={busy || !variants.some(v => v.id === variantId)} onClick={() => onConfirm(variantId)} className={primaryClass}>تأكيد التركيبة وإضافتها للسلة</button>
    </div>
  </Modal>
}
