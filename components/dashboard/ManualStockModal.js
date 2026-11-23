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
  const [loading, setLoading] = useState(false)
  const [retry, setRetry] = useState(0)
  const [loadedScope, setLoadedScope] = useState('')
  const canManage = ['owner', 'manager'].includes(ctx?.role)
  const hasBranch = Boolean(ctx?.storeId && !ctx?.allBranches)
  const scope = `${ctx?.tenantId || ''}:${ctx?.storeId || ''}`
  const catalog = loadedScope === scope ? rows : []
  const catalogLoading = hasBranch && canManage && (loading || loadedScope !== scope)

  useEffect(() => {
    setRows([]); setLoadedScope(''); setError(''); setLoading(false)
    setProductId(''); setVariantId(''); setQuantity(''); setUnitCost('')
    if (!open || !ctx?.tenantId || !hasBranch || !canManage) return
    let cancelled = false
    setLoading(true)
    // Do not join inventory: zero-stock variants and variants without a branch
    // inventory row must remain eligible. Inactive products stay excluded.
    fetchAllRows(supabase.from('products')
      .select('id, name, product_variants(id, color, size, barcode, cost_price_avg)')
      .eq('tenant_id', ctx.tenantId).eq('is_active', true).order('name').order('id'))
      .then(data => { if (!cancelled) { setRows(data); setLoadedScope(scope) } })
      .catch(err => { if (!cancelled) { setError(err.message || 'تعذر تحميل المنتجات'); setLoadedScope(scope) } })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [open, ctx?.tenantId, scope, hasBranch, canManage, retry])

  // Opened from a low-stock alert: preselect the product that owns the variant.
  useEffect(() => {
    if (!open || loadedScope !== scope || !initialVariant || !rows.length) return
    const owner = rows.find(product => (product.product_variants || []).some(variant => variant.id === initialVariant))
    if (owner) {
      setProductId(owner.id)
      setVariantId(initialVariant)
    }
  }, [open, initialVariant, rows, loadedScope, scope])

  const product = catalog.find(row => row.id === productId)
  const variants = product?.product_variants || []
  const variant = variants.find(row => row.id === variantId)

  function close() {
    if (busy) return
    setProductId(''); setVariantId(''); setQuantity(''); setUnitCost(''); setError('')
    onClose()
  }

  async function submit(event) {
    event.preventDefault()
    if (busy || catalogLoading) return
    if (!hasBranch) { setError('يرجى اختيار فرع محدد من الشريط العلوي أولاً'); return }
    if (!canManage) { setError('إضافة المخزون متاحة للمالك والمدير فقط'); return }
    setError('')
    const qty = Number(quantity)
    const cost = Number(unitCost)
    if (!variant) { setError('اختر مقاساً / لوناً صالحاً للمنتج'); return }
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
        {!ctx && <p role="status" className="text-sm text-neutral-400">جاري التحقق من الفرع...</p>}
        {ctx && !hasBranch && <p role="alert" className="text-sm text-amber-300">يرجى اختيار فرع محدد من الشريط العلوي أولاً</p>}
        {ctx && !canManage && <p role="alert" className="text-sm text-amber-300">إضافة المخزون متاحة للمالك والمدير فقط</p>}
        {hasBranch && canManage && <>
          {catalogLoading && <p role="status" className="text-sm text-neutral-400">جاري تحميل المنتجات...</p>}
          <Notice error={error} />
          {error && !catalogLoading && <button type="button" disabled={busy} onClick={() => setRetry(value => value + 1)} className={secondaryClass}>إعادة تحميل المنتجات</button>}
          {!catalogLoading && !error && !catalog.length && <p role="status" className="text-sm text-amber-300">
            لا توجد منتجات نشطة متاحة للإضافة في مؤسستك. قد تعرض شاشة المخزون أرصدة منتجات غير نشطة؛ لا يمكن تزويدها من هذه النافذة.
            {' '}<a href="/dashboard/stock?tab=products" className="underline text-gold">فتح المنتجات</a>
          </p>}
        </>}
        <fieldset disabled={busy || !hasBranch || !canManage || catalogLoading} className="min-w-0 space-y-4 disabled:opacity-60">
        <div className="block text-sm text-neutral-300">
          <span className="mb-1 block">المنتج</span>
          <CustomSelect
            aria-label="المنتج"
            value={productId}
            disabled={busy || !hasBranch || !canManage || catalogLoading || !catalog.length}
            onChange={next => {
              setProductId(next)
              const choices = catalog.find(row => row.id === next)?.product_variants || []
              setVariantId(choices.length === 1 ? choices[0].id : '')
            }}
            options={[{ label: catalogLoading ? 'جاري تحميل المنتجات...' : 'اختر المنتج', value: '' }, ...catalog.map(row => ({ label: row.name, value: row.id }))]}
            className={`${fieldClass} mt-1`}
          />
        </div>
        <div className="block text-sm text-neutral-300">
          <span className="mb-1 block">المقاس / اللون</span>
          <CustomSelect
            aria-label="المقاس / اللون"
            value={variantId}
            onChange={setVariantId}
            disabled={busy || !hasBranch || !canManage || catalogLoading || !productId || !variants.length}
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
        {product && !variants.length && <p role="status" className="text-sm text-amber-300">هذا المنتج لا يحتوي على مقاسات / ألوان محفوظة. يلزم تجهيز تركيبة للمنتج قبل إضافة المخزون.</p>}
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
        </fieldset>
        <div className="flex gap-2 border-t border-white/10 pt-4">
          <button disabled={busy || !hasBranch || !canManage || catalogLoading || !variant} className={`${primaryClass} flex-1`}>{busy ? 'جاري الحفظ...' : 'إضافة المخزون'}</button>
          <button type="button" disabled={busy} onClick={close} className={secondaryClass}>إلغاء</button>
        </div>
      </form>
    </Modal>
  )
}
