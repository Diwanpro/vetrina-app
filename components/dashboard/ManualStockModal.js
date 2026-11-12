'use client'

import { useEffect, useState } from 'react'
import { Modal, Notice, fieldClass, primaryClass, secondaryClass } from '@/components/dashboard/EngineUI'
import CustomSelect from '@/components/ui/CustomSelect'
import { fetchAllRows } from '@/lib/cash'
import { supabase } from '@/lib/supabase'

/**
 * Manual stock addition. Cost price is mandatory: it feeds the weighted
 * average that drives every profit figure in the app.
 */
export default function ManualStockModal({ open, onClose, ctx, initialVariant = '', onSaved }) {
  const [rows, setRows] = useState([])
  const [productId, setProductId] = useState('')
  const [variantId, setVariantId] = useState(initialVariant)
  const [quantity, setQuantity] = useState('')
  const [unitCost, setUnitCost] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!open || !ctx?.tenantId) return
    let cancelled = false
    fetchAllRows(supabase.from('products')
      .select('id, name, product_variants(id, color, size, barcode, cost_price_avg)')
      .eq('tenant_id', ctx.tenantId).eq('is_active', true).order('name'))
      .then(data => { if (!cancelled) setRows(data) })
      .catch(err => { if (!cancelled) setError(err.message) })
    return () => { cancelled = true }
  }, [open, ctx?.tenantId])

  // Opened from a low-stock alert: preselect the product that owns the variant.
  useEffect(() => {
    if (!open || !initialVariant || !rows.length) return
    const owner = rows.find(product => (product.product_variants || []).some(variant => variant.id === initialVariant))
    if (owner) {
      setProductId(owner.id)
      setVariantId(initialVariant)
    }
  }, [open, initialVariant, rows])

  const product = rows.find(row => row.id === productId)
  const variants = product?.product_variants || []
  const variant = variants.find(row => row.id === variantId)

  function close() {
    if (busy) return
    setProductId(''); setVariantId(''); setQuantity(''); setUnitCost(''); setError('')
    onClose()
  }

  async function submit(event) {
    event.preventDefault()
    if (busy) return
    setError('')
    const qty = Number(quantity)
    const cost = Number(unitCost)
    if (!variantId) { setError('اختر المقاس'); return }
    if (!Number.isSafeInteger(qty) || qty <= 0) { setError('أدخل كمية صحيحة أكبر من صفر'); return }
    if (unitCost === '' || !Number.isSafeInteger(cost) || cost < 0) { setError('سعر التكلفة مطلوب'); return }

    setBusy(true)
    try {
      const { error: rpcError } = await supabase.rpc('engine_add_stock_manual', {
        p_store: ctx.storeId,
        p_tenant: ctx.tenantId,
        p_variant: variantId,
        p_quantity: qty,
        p_unit_cost: cost,
        p_request: crypto.randomUUID(),
      })
      if (rpcError) throw rpcError
      setProductId(''); setVariantId(''); setQuantity(''); setUnitCost('')
      onSaved?.()
      onClose()
    } catch (err) {
      setError(err.message || 'تعذر إضافة المخزون')
    } finally {
      setBusy(false)
    }
  }

  if (!open) return null

  return (
    <Modal title="إضافة مخزون يدوي" busy={busy} onClose={close}>
      <form onSubmit={submit} className="space-y-4">
        <Notice error={error} />
        <div className="block text-sm text-neutral-300">
          <span className="mb-1 block">المنتج</span>
          <CustomSelect
            value={productId}
            onChange={next => { setProductId(next); setVariantId('') }}
            options={[{ label: 'اختر المنتج', value: '' }, ...rows.map(row => ({ label: row.name, value: row.id }))]}
            className={`${fieldClass} mt-1`}
          />
        </div>
        <div className="block text-sm text-neutral-300">
          <span className="mb-1 block">المقاس / اللون</span>
          <CustomSelect
            value={variantId}
            onChange={setVariantId}
            disabled={!productId}
            options={[
              { label: productId ? 'اختر المقاس' : 'اختر المنتج أولاً', value: '' },
              ...variants.map(row => ({
                label: `${row.color || 'بدون لون'} / ${row.size || 'موحّد'}${row.barcode ? ` · ${row.barcode}` : ''}`,
                value: row.id,
              })),
            ]}
            className={`${fieldClass} mt-1`}
          />
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="block text-sm text-neutral-300">الكمية
            <input
              inputMode="numeric" required value={quantity} disabled={busy}
              onChange={event => setQuantity(event.target.value.replace(/[^0-9]/g, ''))}
              className={`${fieldClass} mt-1`} placeholder="0"
            />
          </label>
          <label className="block text-sm text-neutral-300">سعر التكلفة للوحدة (دج)
            <input
              inputMode="numeric" required value={unitCost} disabled={busy}
              onChange={event => setUnitCost(event.target.value.replace(/[^0-9]/g, ''))}
              className={`${fieldClass} mt-1`} placeholder="إلزامي"
            />
          </label>
        </div>
        {variant && (
          <p className="text-xs text-neutral-500">
            متوسط التكلفة الحالي: {Number(variant.cost_price_avg || 0).toLocaleString('fr-DZ')} دج — سيُعاد حسابه بمتوسط مرجّح على كل مخزون المؤسسة.
          </p>
        )}
        <div className="flex gap-2 border-t border-white/10 pt-4">
          <button disabled={busy} className={`${primaryClass} flex-1`}>{busy ? 'جاري الحفظ...' : 'إضافة المخزون'}</button>
          <button type="button" disabled={busy} onClick={close} className={secondaryClass}>إلغاء</button>
        </div>
      </form>
    </Modal>
  )
}
