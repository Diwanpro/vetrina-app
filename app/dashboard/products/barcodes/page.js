'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { supabase } from '@/lib/supabase'
import { getAppContext } from '@/lib/app-context'
import { fetchAllRows } from '@/lib/cash'
import { Notice, primaryClass, secondaryClass } from '@/components/dashboard/EngineUI'

function BarcodeLabel({ variant, onReady }) {
  const svg = useRef(null)
  const [error, setError] = useState('')
  useEffect(() => {
    let cancelled = false
    import('jsbarcode').then(({ default: JsBarcode }) => {
      if (!cancelled && svg.current) {
        try {
          JsBarcode(svg.current, variant.barcode || variant.id, { format: 'CODE128', width: 1.5, height: 48, margin: 8, fontSize: 12, background: '#ffffff', lineColor: '#000000', displayValue: true })
          onReady(variant.id)
        } catch { setError('هذا الرمز غير صالح للطباعة بصيغة CODE128') }
      }
    }).catch(() => { if (!cancelled) setError('تعذر تحميل مولّد الباركود') })
    return () => { cancelled = true }
  }, [variant, onReady])
  return <article className="barcode-label rounded-lg border border-neutral-300 bg-white p-3 text-center text-black">
    <p className="text-sm font-bold">{variant.products?.name}</p>
    <p className="mt-1 text-xs">المقاس: {variant.size || '—'} · اللون: {variant.color || '—'}</p>
    <svg ref={svg} role="img" aria-label={`باركود ${variant.barcode || variant.id}`} className="mx-auto mt-1 max-w-full" />
    {error && <p className="text-xs text-red-700">{error}</p>}
  </article>
}

export default function BarcodePrintPage() {
  const [variants, setVariants] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [copies, setCopies] = useState(1)
  const [readyIds, setReadyIds] = useState([])
  const markReady = useCallback(id => setReadyIds(prev => prev.includes(id) ? prev : [...prev, id]), [])
  useEffect(() => {
    let cancelled = false
    async function load() {
      try {
        const productId = new URLSearchParams(window.location.search).get('product')
        if (!productId) throw new Error('اختر منتجاً من صفحة المنتجات')
        const ctx = await getAppContext()
        if (!ctx.tenantId || !ctx.storeId) throw new Error('تعذر تحديد المتجر')
        const rows = await fetchAllRows(supabase.from('product_variants').select('id, color, size, barcode, products!inner(name, tenant_id)')
          .eq('product_id', productId).eq('products.tenant_id', ctx.tenantId).order('id'))
        if (!rows.length) throw new Error('لا توجد مقاسات متاحة لهذا المنتج')
        if (!cancelled) setVariants(rows)
      } catch (err) { if (!cancelled) setError(err.message) }
      finally { if (!cancelled) setLoading(false) }
    }
    load()
    return () => { cancelled = true }
  }, [])
  return <main className="min-h-screen bg-[#141414] p-5 text-neutral-100 print:bg-white print:p-0 print:text-black">
    <style>{`@media print { @page { size: A4; margin: 10mm; } .barcode-label { break-inside: avoid; page-break-inside: avoid; } body { background: white !important; } }`}</style>
    <header className="mb-6 space-y-3 print:hidden">
      <h1 className="text-lg text-gold">طباعة الباركود</h1>
      <p className="text-xs text-neutral-400">ملصق لكل مقاس ولون. المقاسات القديمة دون باركود تستخدم معرّف المقاس وتدعم المسح في نقطة البيع.</p>
      <div className="flex flex-wrap items-center gap-3">
        <label className="text-sm">عدد النسخ لكل مقاس <input type="number" min="1" max="50" value={copies} onChange={e => setCopies(Math.min(50, Math.max(1, Number(e.target.value) || 1)))} className="w-20 rounded border border-neutral-700 bg-black p-2" /></label>
        <button disabled={loading || !variants.length || readyIds.length < variants.length} onClick={() => window.print()} className={primaryClass}>طباعة الملصقات</button>
        <a href="/dashboard/products" className={secondaryClass}>العودة للمنتجات</a>
      </div>
      {loading && <p className="text-sm text-neutral-400">جاري تحميل الملصقات...</p>}
      <Notice error={error} />
    </header>
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 print:grid-cols-3">
      {variants.flatMap(variant => Array.from({ length: copies }, (_, index) => <BarcodeLabel key={`${variant.id}-${index}`} variant={variant} onReady={markReady} />))}
    </div>
  </main>
}
