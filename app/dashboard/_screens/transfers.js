'use client'

import { useEffect, useRef, useState } from 'react'
import { useDashboardSession } from '@/components/dashboard/SessionProvider'
import { Notice, fieldClass, primaryClass, selectClass } from '@/components/dashboard/EngineUI'
import CustomSelect from '@/components/ui/CustomSelect'
import { supabase } from '@/lib/supabase'
import { fetchAllRows, validMoney } from '@/lib/cash'
import { localRows } from '@/lib/local-db'

export default function TransfersPage() {
  const ctx = useDashboardSession()
  const [from, setFrom] = useState(ctx.storeId || ctx.stores[0]?.id || '')
  const [to, setTo] = useState('')
  const [variant, setVariant] = useState('')
  const [quantity, setQuantity] = useState('')
  const [stock, setStock] = useState([])
  const [history, setHistory] = useState([])
  const [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')
  const request = useRef(null)
  useEffect(() => {
    let live = true
    setVariant(''); setStock([]); setLoading(true)
    if (!from) { setLoading(false); return }
    const query = supabase.from('inventory').select('id, variant_id, quantity, product_variants!inner(color, size, products!inner(name, tenant_id))')
      .eq('store_id', from).eq('product_variants.products.tenant_id', ctx.tenantId).gt('quantity', 0).order('id')
    Promise.all([fetchAllRows(query), supabase.rpc('engine_transfer_history')]).then(([rows, result]) => {
      if (result.error) throw result.error
      if (live) { setStock(rows); setHistory(result.data || []) }
    }).catch(err => { if (live) setError(err.message) }).finally(() => { if (live) setLoading(false) })
    return () => { live = false }
  }, [from, success, ctx.tenantId])
  return <>\n    <div className="mx-auto max-w-4xl space-y-5"><h1 className="text-xl text-neutral-100">نقل المخزون بين الفروع</h1><p className="text-sm text-neutral-500">للمالك فقط · يتم خصم وإضافة المخزون في عملية واحدة.</p><Notice error={error} success={success} />\n    <form onSubmit={async event => {\n      event.preventDefault(); if (busy) return\n      setBusy(true); setError(''); setSuccess('')\n      try {\n        if (!navigator.onLine) throw new Error('نقل المخزون يتطلب الاتصال')\n        if (ctx.role !== 'owner' || !ctx.stores.some(store => store.id === from) || !ctx.stores.some(store => store.id === to) || from === to) throw new Error('اختر فرعين مختلفين من مؤسستك')\n        if (!variant || !validMoney(quantity) || Number(quantity) <= 0) throw new Error('اختر المقاس والكمية الموجبة')\n        if ((await localRows()).some(row => row.tenant_id === ctx.tenantId && row.kind === 'sale' && row.status !== 'synced' && [from, to].includes(row.store_id))) throw new Error('زامن فواتير هذه الفروع المحلية قبل نقل المخزون')\n        const key = JSON.stringify([from, to, variant, quantity])\n        if (request.current?.key !== key) request.current = { key, id: crypto.randomUUID() }\n        const { error } = await supabase.rpc('engine_transfer', { p_from: from, p_to: to, p_tenant: ctx.tenantId, p_variant: variant, p_quantity: Number(quantity), p_request: request.current.id })\n        if (error) throw error\n        setSuccess('تم نقل المخزون بنجاح'); setQuantity(''); setVariant(''); request.current = null\n      } catch (err) { setError(err.message) } finally { setBusy(false) }\n    }} className="rounded-2xl border border-gold/20 bg-card p-5\"><fieldset disabled={busy} className="grid gap-4 sm:grid-cols-2">\n      <label className="text-sm text-neutral-300">من الفرع<CustomSelect required value={from} onChange={e => setFrom(e)} options={[{ label: 'اختر الفرع', value: '' }, ...ctx.stores.map(store => ({ label: store.name, value: store.id }))]} className={`${fieldClass} mt-2`} /></label>
      <label className="text-sm text-neutral-300">إلى الفرع<CustomSelect required value={to} onChange={e => setTo(e)} options={[{ label: 'اختر الفرع', value: '' }, ...ctx.stores.filter(store => store.id !== from).map(store => ({ label: store.name, value: store.id }))]} className={`${fieldClass} mt-2`} /></label>
      <label className="block text-sm text-neutral-300">المنتج / اللون / المقاس
        <CustomSelect disabled={loading} required value={variant} onChange={e => setVariant(e)}
          options={[{ label: loading ? 'جاري التحميل...' : 'اختر الصنف', value: '' }, ...stock.map(row => ({
            label: `${row.product_variants.products.name} - ${row.product_variants.color} - ${row.product_variants.size} (المتاح: ${row.quantity})`,
            value: row.variant_id
          }))]}
          className={`${selectClass} mt-2`} />
        {!loading && stock.length === 0 && <span className="mt-1 block text-[11px] text-neutral-500">لا يوجد مخزون في الفرع المحدد.</span>}
      </label>
      <label className="text-sm text-neutral-300">الكمية<input required type="number" min="1" step="1" max={stock.find(row => row.variant_id === variant)?.quantity || 0} value={quantity} onChange={e => setQuantity(e.target.value)} className={`${fieldClass} mt-2`} /></label>
      <button disabled={loading || ctx.stores.length < 2} className={primaryClass}>{busy ? 'جاري النقل...' : 'تأكيد النقل'}</button>
    </fieldset></form>
    <section className="rounded-2xl border border-white/10 bg-card p-5"><h2 className="mb-4 text-gold">آخر عمليات النقل</h2><div className="space-y-3">{history.map(row => <div key={row.id} className="rounded-lg border border-white/5 p-3 text-sm text-neutral-300">من {ctx.stores.find(store => store.id === row.from_store_id)?.name} إلى {ctx.stores.find(store => store.id === row.to_store_id)?.name}<span className="mt-1 block text-xs text-neutral-500">{new Date(row.created_at).toLocaleString('ar-DZ')} · {row.status === 'completed' ? 'مكتمل' : row.status}</span></div>)}{!history.length && <p className="text-sm text-neutral-500">لا توجد عمليات نقل.</p>}</div></section>\n  </div></>\n}
