'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import VoiceInput from '@/components/VoiceInput'
import { Modal, Notice, fieldClass, primaryClass, secondaryClass } from '@/components/dashboard/EngineUI'
import CustomSelect from '@/components/ui/CustomSelect'
import { supabase } from '@/lib/supabase'
import { getAppContext, formatDzd } from '@/lib/app-context'
import { fetchAllRows } from '@/lib/cash'
import { purchasePayload, purchaseTotal } from '@/lib/engine'
import { matrixAxes, matrixItems, replaceProductSeries } from '@/lib/purchase-matrix'

export default function PurchasesPage() {
  const [suppliers, setSuppliers] = useState([])
  const [variants, setVariants] = useState([])
  const [history, setHistory] = useState([])
  const [supplier, setSupplier] = useState('')
  const [description, setDescription] = useState('')
  const [items, setItems] = useState([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')
  const [adding, setAdding] = useState(false)
  const [productId, setProductId] = useState('')
  const [quantities, setQuantities] = useState({})
  const [unitCost, setUnitCost] = useState('')
  const [matrixError, setMatrixError] = useState('')
  const saving = useRef(false)
  const request = useRef(null)
  const total = purchaseTotal(items)
  const products = useMemo(() => [...new Map(variants.map(variant => [variant.product_id, variant.products])).values()]
    .sort((a, b) => a.name.localeCompare(b.name, 'ar')), [variants])
  const selectedVariants = variants.filter(variant => variant.product_id === productId)
  const { colors, sizes } = matrixAxes(selectedVariants)
  const variantById = useMemo(() => new Map(variants.map(variant => [variant.id, variant])), [variants])
  const groups = useMemo(() => {
    const grouped = new Map()
    for (const item of items) {
      const variant = variantById.get(item.variant_id)
      if (!variant) continue
      if (!grouped.has(variant.product_id)) grouped.set(variant.product_id, { product: variant.products, items: [] })
      grouped.get(variant.product_id).items.push(item)
    }
    return [...grouped.values()]
  }, [items, variantById])

  async function load() {
    setLoading(true)
    try {
      const ctx = await getAppContext()
      if (!ctx.storeId || !ctx.tenantId) throw new Error('تعذر تحديد المتجر أو المؤسسة')
      const [supplierRows, variantRows, purchaseResult] = await Promise.all([
        fetchAllRows(supabase.rpc('engine_suppliers', { p_store: ctx.storeId, p_tenant: ctx.tenantId }).select('id, name').eq('tenant_id', ctx.tenantId).eq('store_id', ctx.storeId).order('name').order('id')),
        fetchAllRows(supabase.from('product_variants').select('id, product_id, color, size, barcode, cost_price_avg, inventory!inner(store_id), products!inner(id, name, tenant_id, is_active)')
          .eq('products.tenant_id', ctx.tenantId).eq('inventory.store_id', ctx.storeId).eq('products.is_active', true).order('id')),
        supabase.rpc('engine_purchases', { p_store: ctx.storeId, p_tenant: ctx.tenantId }).select('id, supplier_name, description, total_amount, created_at').eq('store_id', ctx.storeId).eq('tenant_id', ctx.tenantId).order('created_at', { ascending: false }).limit(20),
      ])
      if (purchaseResult.error) throw purchaseResult.error
      setSuppliers(supplierRows); setVariants(variantRows); setHistory(purchaseResult.data || [])
    } catch (err) { setError(err.message) }
    finally { setLoading(false) }
  }
  useEffect(() => { load() }, [])

  function selectProduct(id) {
    const productVariants = variants.filter(variant => variant.product_id === id)
    const ids = new Set(productVariants.map(variant => variant.id))
    const existing = items.filter(item => ids.has(item.variant_id))
    setProductId(id)
    setQuantities(Object.fromEntries(existing.map(item => [item.variant_id, String(item.quantity)])))
    setUnitCost(existing.length ? String(existing[0].unit_cost) : '')
    setMatrixError('')
  }
  function openMatrix(id = '') {
    selectProduct(id); setAdding(true)
  }
  function applyMatrix(event) {
    event.preventDefault()
    try {
      if (!productId) throw new Error('اختر المنتج أولاً')
      const next = matrixItems(selectedVariants, quantities, unitCost)
      setItems(replaceProductSeries(items, selectedVariants.map(variant => variant.id), next))
      setAdding(false); setError(''); setSuccess('')
    } catch (err) { setMatrixError(err.message) }
  }
  async function save(event) {
    event.preventDefault()
    if (saving.current) return
    saving.current = true; setBusy(true); setError(''); setSuccess('')
    try {
      const ctx = await getAppContext()
      if (!ctx.storeId || !ctx.tenantId || !supplier) throw new Error('اختر المورد وتأكد من المتجر')
      const payload = purchasePayload(items)
      if (purchaseTotal(payload) > 2147483647) throw new Error('إجمالي الفاتورة كبير جداً')
      const text = description.trim()
      const key = JSON.stringify({ supplier, payload, description: text })
      if (request.current?.key !== key) request.current = { key, id: crypto.randomUUID() }
      const { error } = await supabase.rpc('engine_receive_purchase_with_description', {
        p_store: ctx.storeId, p_tenant: ctx.tenantId, p_supplier: supplier,
        p_items: payload, p_request: request.current.id, p_description: text,
      })
      if (error) throw error
      setSuccess('تم استلام الفاتورة وتحديث المخزون والدين ومتوسط التكلفة')
      setItems([]); setSupplier(''); setDescription(''); request.current = null
      await load()
    } catch (err) { setError(err.message || 'تعذر حفظ الفاتورة') }
    finally { saving.current = false; setBusy(false) }
  }

  return <>
    <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
      <div><p className="mb-1 text-xs text-gold">المشتريات · استلام السلاسل</p><h1 className="text-xl font-medium text-neutral-100">فاتورة شراء جديدة</h1><p className="mt-2 text-xs text-neutral-500">اختر المورد، أضف المنتجات بالألوان والمقاسات، ثم استلم الفاتورة.</p></div>
      <a href="/dashboard/stock?tab=suppliers" className={secondaryClass}>إدارة الموردين</a>
    </div>
    <Notice error={error} success={success} />
    {loading && <p className="mb-3 text-sm text-neutral-400">جاري التحميل...</p>}
    <form onSubmit={save} className="space-y-4">
      <fieldset disabled={busy || loading} className="space-y-4 disabled:opacity-60">
        <div className="grid gap-5 rounded-2xl border border-white/10 bg-card p-5 lg:grid-cols-2">
          <div className="block text-sm text-neutral-300"><span className="mb-2 block text-gold">01 · المورد</span>
            <CustomSelect
              required
              value={supplier}
              onChange={e => setSupplier(e)}
              options={[{ label: 'اختر المورد', value: '' }, ...suppliers.map(row => ({ label: row.name, value: row.id }))]}
              className={fieldClass}
            />
            {!suppliers.length && !loading && <span className="mt-2 block text-xs text-neutral-500">أضف مورداً من صفحة الموردين أولاً.</span>}
          </div>
          <div>
            <div className="mb-2 flex items-start justify-between gap-3">
              <label htmlFor="purchase-description" className="text-sm text-neutral-300">وصف المنتج <span className="text-xs text-neutral-500">(للفاتورة)</span></label>
              <VoiceInput value={description} onChange={setDescription} disabled={busy || loading} />
            </div>
            <textarea id="purchase-description" rows={3} maxLength={4000} value={description} onChange={e => setDescription(e.target.value)} placeholder="مثال: سلسلة سراويل جينز بألوان ومقاسات متنوعة…" className={`${fieldClass} resize-y`} />
          </div>
        </div>
        <section className="rounded-2xl border border-white/10 bg-card p-5">
          <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
            <div><h2 className="text-sm text-gold">02 · المنتجات والسلاسل</h2><p className="mt-1 text-xs text-neutral-500">أدخل كميات كل الألوان والمقاسات دفعة واحدة.</p></div>
            <button type="button" disabled={!supplier || !products.length} onClick={() => openMatrix()} className={primaryClass}>+ إضافة منتج</button>
          </div>
          {!groups.length ? <div className="rounded-xl border border-dashed border-white/10 bg-black/10 px-4 py-10 text-center">
            <p className="text-sm text-neutral-300">ابدأ بإضافة أول سلسلة</p><p className="mt-2 text-xs text-neutral-500">{!supplier ? 'اختر المورد لتفعيل زر إضافة منتج.' : !products.length ? 'أضف منتجات ومقاسات من صفحة المنتجات أولاً.' : 'اختر المنتج، ثم املأ جدول الكميات حسب اللون والمقاس.'}</p>
          </div> : <div className="space-y-4">{groups.map(group => <article key={group.product.id} className="rounded-xl border border-white/10 bg-black/10 p-4">
            <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
              <div><h3 className="font-medium text-neutral-100">{group.product.name}</h3><p className="mt-1 text-xs text-neutral-500">{group.items.reduce((sum, item) => sum + Number(item.quantity), 0)} قطعة · {group.items.length} مقاس/لون</p></div>
              <div className="flex gap-2"><button type="button" onClick={() => openMatrix(group.product.id)} className={secondaryClass}>تعديل السلسلة</button><button type="button" aria-label={`حذف ${group.product.name}`} onClick={() => setItems(prev => prev.filter(item => !group.items.some(row => row.variant_id === item.variant_id)))} className="px-2 text-xs text-red-300">حذف</button></div>
            </div>
            <div className="overflow-x-auto"><table className="w-full text-right text-xs"><thead className="text-neutral-500"><tr><th className="p-2">اللون</th><th className="p-2">المقاس</th><th className="p-2">الكمية</th><th className="p-2">تكلفة الوحدة</th><th className="p-2">الإجمالي</th></tr></thead><tbody>
              {group.items.map(item => { const variant = variantById.get(item.variant_id); return <tr key={item.variant_id} className="border-t border-white/5 text-neutral-300"><td className="p-2">{variant?.color || 'بدون لون'}</td><td className="p-2">{variant?.size || 'موحّد'}</td><td className="p-2">{item.quantity}</td><td className="p-2">{formatDzd(item.unit_cost)}</td><td className="p-2 text-gold">{formatDzd(purchaseTotal([item]))}</td></tr> })}
            </tbody></table></div>
            <p className="mt-3 border-t border-white/5 pt-3 text-left text-sm text-gold">إجمالي السلسلة: {formatDzd(purchaseTotal(group.items))}</p>
          </article>)}</div>}
        </section>
        <div className="flex flex-wrap items-center justify-between gap-4 rounded-2xl border border-gold/30 bg-card p-5">
          <div><p className="mb-1 text-xs text-neutral-400">{groups.length} منتج · {items.reduce((sum, item) => sum + Number(item.quantity), 0)} قطعة</p><p className="text-xl font-medium text-gold">الإجمالي: {formatDzd(total)}</p><p className="mt-2 text-xs text-neutral-500">يضاف كامل المبلغ إلى دين المورد عند الاستلام.</p></div>
          <button disabled={!supplier || !items.length} className={`${primaryClass} min-w-48 py-3`}>{busy ? 'جاري الاستلام...' : 'حفظ واستلام الفاتورة'}</button>
        </div>
      </fieldset>
    </form>
    {adding && <Modal title="إضافة سلسلة · الألوان والمقاسات" wide busy={busy} onClose={() => setAdding(false)}>
      <form onSubmit={applyMatrix} className="space-y-4">
        <Notice error={matrixError} />
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="text-sm text-neutral-300">المنتج<CustomSelect value={productId} onChange={e => selectProduct(e)} options={[{ label: 'اختر المنتج', value: '' }, ...products.map(product => ({ label: product.name, value: product.id }))]} className={`${fieldClass} mt-2`} /></div>
          <label className="text-sm text-neutral-300">تكلفة الوحدة لكل قطع السلسلة (دج)<input required type="number" min="0" step="1" max="2147483647" value={unitCost} onChange={e => setUnitCost(e.target.value)} className={`${fieldClass} mt-2`} /></label>
        </div>
        {productId && <>
          <p className="text-xs text-neutral-500">أدخل الكميات المطلوبة. الخانات الفارغة أو الصفرية لا تضاف للفاتورة. — يعني أن هذا اللون والمقاس غير مسجل.</p>
          <div className="overflow-x-auto rounded-xl border border-white/10"><table className="w-full text-center text-sm"><caption className="sr-only">كميات السلسلة حسب اللون والمقاس</caption>
            <thead className="bg-[#222] text-gold"><tr><th scope="col" className="p-3 text-right">اللون / المقاس</th>{sizes.map(size => <th scope="col" key={size} className="p-3">{size || 'موحّد'}</th>)}</tr></thead>
            <tbody>{colors.map(color => <tr key={color} className="border-t border-white/5"><th scope="row" className="whitespace-nowrap p-3 text-right text-xs font-normal text-neutral-300">{color || 'بدون لون'}</th>{sizes.map(size => {
              const matches = selectedVariants.filter(variant => (variant.color ?? '') === color && (variant.size ?? '') === size)
              return <td key={size} className="p-2">{matches.length ? matches.map(variant => <input key={variant.id} aria-label={`كمية ${color || 'بدون لون'} مقاس ${size || 'موحّد'}${matches.length > 1 ? ` ${variant.barcode || ''}` : ''}`} type="number" min="0" step="1" max="2147483647" placeholder="0" value={quantities[variant.id] ?? ''} onChange={e => setQuantities(prev => ({ ...prev, [variant.id]: e.target.value }))} className="my-1 w-20 rounded-lg border border-neutral-700 bg-[#141414] px-2 py-2 text-center text-neutral-100 outline-none focus:border-gold" />) : <span className="text-neutral-700">—</span>}</td>
            })}</tr>)}</tbody>
          </table></div>
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl bg-gold/5 p-3 text-sm">
            <span className="text-neutral-300">القطع: {selectedVariants.reduce((sum, variant) => sum + Math.max(0, Number(quantities[variant.id]) || 0), 0)}</span>
            <span className="text-gold">الإجمالي: {formatDzd(selectedVariants.reduce((sum, variant) => sum + Math.max(0, Number(quantities[variant.id]) || 0), 0) * (Number(unitCost) || 0))}</span>
          </div>
        </>}
        <div className="flex gap-3 border-t border-white/10 pt-4"><button disabled={!productId} className={`${primaryClass} flex-1`}>تأكيد السلسلة</button><button type="button" onClick={() => setAdding(false)} className={secondaryClass}>إلغاء</button></div>
      </form>
    </Modal>}
    <section className="mt-6 rounded-2xl border border-white/10 bg-card p-5">
      <h2 className="mb-4 text-sm text-neutral-200">آخر 20 فاتورة شراء</h2>
      {!history.length ? <p className="text-sm text-neutral-500">لا توجد فواتير بعد.</p> : <div className="overflow-x-auto"><table className="w-full text-right text-sm">
        <thead className="text-neutral-500"><tr><th className="p-2">المورد</th><th className="p-2">وصف المنتج</th><th className="p-2">التاريخ</th><th className="p-2">الإجمالي</th></tr></thead>
        <tbody>{history.map(row => <tr key={row.id} className="border-t border-white/5 text-neutral-300"><td className="p-2">{row.supplier_name}</td><td className="max-w-sm whitespace-pre-wrap p-2 text-xs text-neutral-400">{row.description || '—'}</td><td className="whitespace-nowrap p-2">{new Date(row.created_at).toLocaleString('ar-DZ')}</td><td className="whitespace-nowrap p-2 text-gold">{formatDzd(row.total_amount)}</td></tr>)}</tbody>
      </table></div>}
    </section>
  </>
}
