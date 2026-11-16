'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { supabase } from '@/lib/supabase'
import { getAppContext } from '@/lib/app-context'
import { fetchAllRows } from '@/lib/cash'
import { Notice, primaryClass, secondaryClass } from '@/components/dashboard/EngineUI'
import CustomSelect from '@/components/ui/CustomSelect'
import { barcodeLabels } from '@/lib/barcode/hybrid'

function BarcodeLabel({ label, labelId, onReady }) {
  const svg = useRef(null)
  const [error, setError] = useState('')
  useEffect(() => {
    let cancelled = false
    onReady(labelId, false)
    import('jsbarcode').then(({ default: JsBarcode }) => {
      if (cancelled || !svg.current) return
      try {
        JsBarcode(svg.current, label.barcode, { format: 'CODE128', width: 1.5, height: 48, margin: 8, fontSize: 12, background: '#ffffff', lineColor: '#000000', displayValue: true })
        setError(''); onReady(labelId, true)
      } catch { setError('هذا الرمز غير صالح للطباعة بصيغة CODE128') }
    }).catch(() => { if (!cancelled) setError('تعذر تحميل مولّد الباركود') })
    return () => { cancelled = true }
  }, [label, labelId, onReady])
  return <article className="barcode-label rounded-lg border border-neutral-300 bg-white p-3 text-center text-black">
    <p className="text-sm font-bold">{label.name}</p>
    <p className="mt-1 text-xs">{label.detail}</p>
    <svg ref={svg} role="img" aria-label={`باركود ${label.barcode}`} className="mx-auto mt-1 max-w-full" />
    {error && <p role="alert" className="text-xs text-red-700">{error}</p>}
  </article>
}

export default function BarcodePrintPage() {
  const [catalog, setCatalog] = useState({ product: null, variants: [], records: [] })
  const [mode, setMode] = useState('variant')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [copies, setCopies] = useState(1)
  const [readyIds, setReadyIds] = useState([])
  const markReady = useCallback((id, ready) => setReadyIds(prev => ready ? prev.includes(id) ? prev : [...prev, id] : prev.filter(value => value !== id)), [])
  useEffect(() => {
    let cancelled = false
    async function load() {
      try {
        const productId = new URLSearchParams(window.location.search).get('product')
        if (!productId) throw new Error('اختر منتجاً من صفحة المنتجات')
        const ctx = await getAppContext()
        if (!ctx.tenantId || !ctx.storeId) throw new Error('تعذر تحديد المتجر')
        const { data: product, error: productError } = await supabase.from('products').select('id, name').eq('id', productId).eq('tenant_id', ctx.tenantId).single()
        if (productError) throw productError
        const variants = await fetchAllRows(supabase.from('product_variants').select('id, color, color_components, size, inventory!inner(store_id)')
          .eq('product_id', productId).eq('inventory.store_id', ctx.storeId).order('id'))
        const records = await fetchAllRows(supabase.from('product_barcodes').select('id, product_id, variant_id, barcode, barcode_type, is_primary')
          .eq('tenant_id', ctx.tenantId).eq('product_id', productId).order('id'))
        if (!cancelled) setCatalog({ product, variants, records })
      } catch (err) { if (!cancelled) setError(err.message) }
      finally { if (!cancelled) setLoading(false) }
    }
    load()
    return () => { cancelled = true }
  }, [])
  const labels = useMemo(() => catalog.product ? barcodeLabels(catalog.product, catalog.variants, catalog.records, mode) : [], [catalog, mode])
  const printed = useMemo(() => labels.flatMap(label => Array.from({ length: copies }, (_, index) => ({ label, id: `${label.id}:${index}` }))), [labels, copies])
  return <main className="min-h-screen bg-[#141414] p-5 text-neutral-100 print:bg-white print:p-0 print:text-black">
    <style>{`@media print { @page { size: A4; margin: 10mm; } .barcode-label { break-inside: avoid; page-break-inside: avoid; } body { background: white !important; } }`}</style>
    <header className="mb-6 space-y-3 print:hidden">
      <h1 className="text-lg text-gold">طباعة الباركود</h1>
      <p className="text-xs text-neutral-400">تُطبع القيم المحفوظة كما هي؛ قاعدة البيانات تمنع تعديل الرمز أو نقله إلى منتج آخر. التركيبات القديمة دون رمز تستخدم UUID.</p>
      <div className="max-w-sm"><CustomSelect label="نوع الملصقات" aria-label="نوع الباركود للطباعة" value={mode} onChange={setMode} options={[{ value: 'model', label: 'باركود الموديل' }, { value: 'variant', label: 'باركود التركيبة' }, { value: 'both', label: 'كلاهما' }]} /></div>
      <div className="flex flex-wrap items-center gap-3">
        <label className="text-sm">عدد النسخ لكل رمز <input type="number" min="1" max="50" value={copies} onChange={e => setCopies(Math.min(50, Math.max(1, Math.trunc(Number(e.target.value)) || 1)))} className="w-20 rounded border border-neutral-700 bg-black p-2" /></label>
        <button disabled={loading || !!error || !printed.length || !printed.every(row => readyIds.includes(row.id))} onClick={() => window.print()} className={primaryClass}>طباعة الملصقات</button>
        <a href="/dashboard/stock?tab=products" className={secondaryClass}>العودة للمنتجات</a>
      </div>
      {loading && <p className="text-sm text-neutral-400">جاري تحميل الملصقات...</p>}
      {!loading && !error && !labels.length && <p role="status" className="text-sm text-amber-300">لا توجد رموز محفوظة من النوع المختار. لم يُنشأ أو يُغيّر أي باركود.</p>}
      <Notice error={error} />
    </header>
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 print:grid-cols-3">
      {printed.map(row => <BarcodeLabel key={row.id} label={row.label} labelId={row.id} onReady={markReady} />)}
    </div>
  </main>
}
