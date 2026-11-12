'use client'

import { useCallback, useEffect, useState } from 'react'
import { getAppContext } from '@/lib/app-context'
import { scopeQuery } from '@/lib/access'
import { fetchAllRows } from '@/lib/cash'
import { supabase } from '@/lib/supabase'
import ManualStockModal from '@/components/dashboard/ManualStockModal'
import { secondaryClass } from '@/components/dashboard/EngineUI'

export default function InventoryPage() {
  const [rows, setRows] = useState([])
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [ctx, setCtx] = useState(null)
  const [threshold, setThreshold] = useState(10)
  const [adding, setAdding] = useState(null) // null = closed, '' = open with no variant
  const [version, setVersion] = useState(0)

  useEffect(() => {
    let live = true
    ;(async () => {
      try {
        const context = await getAppContext()
        if (live) setCtx(context)
        const data = await fetchAllRows(scopeQuery(supabase.from('inventory')
          .select('id, quantity, stores!inner(tenant_id), product_variants!inner(id, color, size, barcode, products!inner(name, tenant_id))')
          .eq('product_variants.products.tenant_id', context.tenantId).order('id'), context))
        if (live) setRows(data)
        // The alert threshold is per store, not a hardcoded 5.
        const store = await supabase.from('stores').select('low_stock_alert').eq('id', context.storeId).single()
        if (live && Number.isFinite(Number(store.data?.low_stock_alert))) setThreshold(Number(store.data.low_stock_alert))
      } catch (err) { if (live) setError(err.message) } finally { if (live) setLoading(false) }
    })()
    return () => { live = false }
  }, [version])

  const reload = useCallback(() => setVersion(value => value + 1), [])

  return (
    <>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl text-neutral-100">المخزون</h1>
        <button type="button" className={secondaryClass} onClick={() => setAdding('')}>إضافة مخزون يدوي</button>
      </div>
      {error && <p role="alert" className="mb-4 text-red-300">{error}</p>}
      {loading ? <p className="text-neutral-500">جاري التحميل...</p> : (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {rows.map(row => {
            const low = Number(row.quantity) <= threshold
            return (
              <article key={row.id} className="rounded-xl border border-white/10 bg-card p-4">
                <h2 className="text-neutral-200">{row.product_variants.products.name}</h2>
                <p className="mt-2 text-sm text-neutral-400">{row.product_variants.color} / {row.product_variants.size}</p>
                <p className={`mt-3 text-lg ${low ? 'text-red-300' : 'text-gold'}`}>{row.quantity} قطعة</p>
                {low && <p className="mt-1 text-[11px] text-red-300/80">تحت حد التنبيه ({threshold})</p>}
                <button
                  type="button"
                  onClick={() => setAdding(row.product_variants.id || '')}
                  className="mt-3 rounded-lg border border-gold/20 px-3 py-1.5 text-xs text-gold"
                >
                  إضافة كمية
                </button>
              </article>
            )
          })}
        </div>
      )}
      <ManualStockModal
        open={adding !== null}
        initialVariant={adding || ''}
        ctx={ctx}
        onClose={() => setAdding(null)}
        onSaved={reload}
      />
    </>
  )
}
