'use client'

import { useEffect, useRef, useState } from 'react'
import DashboardShell from '@/components/dashboard/DashboardShell'
import { Notice, fieldClass, primaryClass, secondaryClass } from '@/components/dashboard/EngineUI'
import { supabase } from '@/lib/supabase'
import { getAppContext, formatDzd } from '@/lib/app-context'
import { fetchAllRows } from '@/lib/cash'
import { purchasePayload, purchaseTotal } from '@/lib/engine'

const emptyItem = () => ({ variant_id: '', quantity: '1', unit_cost: '' })
export default function PurchasesPage() {
  const [suppliers, setSuppliers] = useState([])
  const [variants, setVariants] = useState([])
  const [history, setHistory] = useState([])
  const [supplier, setSupplier] = useState('')
  const [items, setItems] = useState([emptyItem()])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')
  const saving = useRef(false)
  const request = useRef(null)
  const total = purchaseTotal(items)

  async function load() {
    setLoading(true)
    try {
      const ctx = await getAppContext()
      if (!ctx.storeId || !ctx.tenantId) throw new Error('تعذر تحديد المتجر أو المؤسسة')
      const [supplierRows, variantRows, purchaseResult] = await Promise.all([
        fetchAllRows(supabase.from('suppliers').select('id, name').eq('tenant_id', ctx.tenantId).eq('store_id', ctx.storeId).order('name').order('id')),
        fetchAllRows(supabase.from('product_variants').select('id, color, size, barcode, cost_price_avg, products!inner(name, tenant_id, is_active)')
          .eq('products.tenant_id', ctx.tenantId).eq('products.is_active', true).order('id')),
        supabase.from('purchases').select('id, supplier_name, total_amount, created_at').eq('store_id', ctx.storeId).eq('tenant_id', ctx.tenantId).order('created_at', { ascending: false }).limit(20),
      ])
      if (purchaseResult.error) throw purchaseResult.error
      setSuppliers(supplierRows); setVariants(variantRows); setHistory(purchaseResult.data || [])
    } catch (err) { setError(err.message) }
    finally { setLoading(false) }
  }
  useEffect(() => { load() }, [])

  function updateItem(index, field, value) {
    setItems(prev => prev.map((item, i) => i === index ? { ...item, [field]: value } : item))
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
      const key = JSON.stringify({ supplier, payload })
      if (request.current?.key !== key) request.current = { key, id: crypto.randomUUID() }
      const { data, error } = await supabase.rpc('engine_receive_purchase', {
        p_store: ctx.storeId, p_tenant: ctx.tenantId, p_supplier: supplier,
        p_items: payload, p_request: request.current.id,
      })
      if (error) throw error
      setSuccess(`تم استلام الفاتورة وتحديث المخزون والدين ومتوسط التكلفة · ${String(data).slice(0, 8)}`)
      setItems([emptyItem()]); setSupplier(''); request.current = null
      await load()
    } catch (err) { setError(err.message || 'تعذر حفظ الفاتورة') }
    finally { saving.current = false; setBusy(false) }
  }

  return <DashboardShell active="/dashboard/purchases">
    <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
      <div><h1 className="text-lg text-neutral-100">المشتريات</h1><p className="mt-1 text-xs text-neutral-500">استلام المخزون وتحديث متوسط التكلفة المرجّح</p></div>
      <a href="/dashboard/suppliers" className={secondaryClass}>إدارة الموردين</a>
    </div>
    <Notice error={error} success={success} />
    {loading && <p className="mb-3 text-sm text-neutral-400">جاري التحميل...</p>}
    <form onSubmit={save} className="rounded-xl border border-white/10 bg-card p-4">
      <fieldset disabled={busy || loading} className="space-y-4 disabled:opacity-60">
        <legend className="mb-4 text-sm text-gold">فاتورة شراء جديدة</legend>
        <label className="block max-w-lg text-sm text-neutral-300">المورد
          <select required value={supplier} onChange={e => setSupplier(e.target.value)} className={`${fieldClass} mt-1`}>
            <option value="">اختر المورد</option>{suppliers.map(row => <option key={row.id} value={row.id}>{row.name}</option>)}
          </select>
        </label>
        {!suppliers.length && !loading && <p className="text-xs text-neutral-500">أضف مورداً من صفحة الموردين أولاً.</p>}
        <div className="space-y-3">{items.map((item, index) => <div key={index} className="grid grid-cols-2 items-end gap-3 rounded-xl border border-white/5 bg-black/10 p-3 lg:grid-cols-[minmax(0,3fr)_1fr_1fr_1fr_auto]">
          <label className="col-span-2 text-xs text-neutral-400 lg:col-span-1">المنتج / المقاس · Variant ID
            <select required value={item.variant_id} onChange={e => updateItem(index, 'variant_id', e.target.value)} className={`${fieldClass} mt-1`}>
              <option value="">اختر المقاس</option>{variants.map(variant => <option key={variant.id} value={variant.id} disabled={items.some((other, i) => i !== index && other.variant_id === variant.id)}>
                {variant.products?.name} · {variant.color || '—'} / {variant.size || '—'} · {variant.id}
              </option>)}
            </select>
          </label>
          <label className="text-xs text-neutral-400">الكمية<input required type="number" min="1" step="1" value={item.quantity} onChange={e => updateItem(index, 'quantity', e.target.value)} className={`${fieldClass} mt-1`} /></label>
          <label className="text-xs text-neutral-400">تكلفة الوحدة (دج)<input required type="number" min="0" step="1" value={item.unit_cost} onChange={e => updateItem(index, 'unit_cost', e.target.value)} className={`${fieldClass} mt-1`} /></label>
          <p className="py-2 text-sm text-gold">{formatDzd(purchaseTotal([item]))}</p>
          <button type="button" disabled={items.length === 1} onClick={() => setItems(prev => prev.filter((_, i) => i !== index))} className={secondaryClass}>حذف</button>
        </div>)}</div>
        <button type="button" disabled={items.length >= 200} onClick={() => setItems(prev => [...prev, emptyItem()])} className={secondaryClass}>+ إضافة بند</button>
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-white/10 pt-4">
          <div><p className="text-lg text-gold">الإجمالي: {formatDzd(total)}</p><p className="mt-1 text-xs text-neutral-500">يضاف كامل المبلغ إلى دين المورد عند الاستلام.</p></div>
          <button disabled={!suppliers.length || !variants.length} className={primaryClass}>{busy ? 'جاري الاستلام...' : 'حفظ واستلام الفاتورة'}</button>
        </div>
      </fieldset>
    </form>
    <section className="mt-6 rounded-xl border border-white/10 bg-card p-4">
      <h2 className="mb-4 text-sm text-neutral-200">آخر 20 فاتورة شراء</h2>
      {!history.length ? <p className="text-sm text-neutral-500">لا توجد فواتير بعد.</p> : <div className="overflow-x-auto"><table className="w-full text-right text-sm">
        <thead className="text-neutral-500"><tr><th className="p-2">الفاتورة</th><th className="p-2">المورد</th><th className="p-2">التاريخ</th><th className="p-2">الإجمالي</th></tr></thead>
        <tbody>{history.map(row => <tr key={row.id} className="border-t border-white/5 text-neutral-300"><td className="p-2" title={row.id}>{row.id.slice(0, 8)}</td><td className="p-2">{row.supplier_name}</td><td className="p-2">{new Date(row.created_at).toLocaleString('ar-DZ')}</td><td className="p-2 text-gold">{formatDzd(row.total_amount)}</td></tr>)}</tbody>
      </table></div>}
    </section>
  </DashboardShell>
}
