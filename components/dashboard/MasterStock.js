'use client'
import { useEffect, useState } from 'react'
import { supabase } from '@/lib/supabase'
import CustomSelect from '@/components/ui/CustomSelect'

export default function MasterStock({ ctx, variants = [] }) {
  const [rows, setRows] = useState([])
  const [variant, setVariant] = useState('')
  const [quantity, setQuantity] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    if (!ctx?.storeId || !['owner', 'manager'].includes(ctx.role)) return
    let live = true
    supabase.rpc('engine_master_stock', { p_store: ctx.storeId }).then(({ data, error }) => {
      if (!live) return
      if (error) setError(error.message)
      else setRows(data || [])
    })
    return () => { live = false }
  }, [ctx?.storeId, ctx?.role])
  if (!ctx?.storeId || !['owner', 'manager'].includes(ctx.role)) return null
  async function save(e) {
    e.preventDefault()
    const qty = Number(quantity)
    if (!variant || !quantity.trim() || !Number.isSafeInteger(qty) || qty < 0) { setError('اختر الصنف وأدخل كمية صحيحة غير سالبة'); return }
    setBusy(true); setError('')
    try {
      const { data, error } = await supabase.rpc('engine_master_stock', { p_store: ctx.storeId, p_variant: variant, p_quantity: qty })
      if (error) throw error
      setRows(data || [])
    } catch (err) { setError(err.message) }
    finally { setBusy(false) }
  }
  return <section className="mb-5 rounded-xl border border-gold/20 p-4">
    <h2 className="mb-2 text-gold">مخزون المستودع (Master) · مستقل عن مخزون المعرض (Branch)</h2>
    {error && <p role="alert" className="text-xs text-red-300">{error}</p>}
    {ctx.role === 'owner' && <form onSubmit={save} className="my-3 space-y-2">
      <CustomSelect aria-label="صنف المستودع" value={variant} onChange={setVariant} options={[...new Map(variants.map(row => [row.product_variants.id, { value: row.product_variants.id, label: `${row.product_variants.products.name} · ${row.product_variants.color} / ${row.product_variants.size}` }])).values()]} placeholder="اختر المقاس واللون" />
      <input aria-label="الرصيد الفعلي للمستودع" value={quantity} onChange={e => setQuantity(e.target.value)} type="number" min="0" step="1" className="rounded-lg bg-[#141414] p-2 text-sm" placeholder="الرصيد الفعلي للمستودع" />
      <button disabled={busy} type="submit" className="mx-2 rounded-lg border border-gold/30 px-3 py-2 text-xs text-gold disabled:opacity-50">تعيين رصيد المستودع</button>
      <p className="text-xs text-neutral-400">هذا جرد لرصيد المستودع، لا يخصم من المعرض. نقل كامل رصيد الصنف للمعرض متاح من تنبيه النفاد.</p>
    </form>}
    <ul className="space-y-1 text-xs text-neutral-300">{rows.map(row => <li key={row.id}>{row.name} · {row.color} / {row.size} — {row.quantity} قطعة</li>)}</ul>
  </section>
}
