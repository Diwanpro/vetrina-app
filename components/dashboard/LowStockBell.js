'use client'

import { useCallback, useEffect, useState } from 'react'
import { getAppContext } from '@/lib/app-context'
import { scopeQuery } from '@/lib/access'
import { fetchAllRows } from '@/lib/cash'
import { supabase } from '@/lib/supabase'
import ManualStockModal from '@/components/dashboard/ManualStockModal'

const DEFAULT_THRESHOLD = 10

/**
 * Low-stock bell. Uses the store's own low_stock_alert threshold, not the
 * hardcoded value the inventory screen and the KPI card used before.
 */
export default function LowStockBell() {
  const [alerts, setAlerts] = useState([])
  const [ctx, setCtx] = useState(null)
  const [threshold, setThreshold] = useState(DEFAULT_THRESHOLD)
  const [open, setOpen] = useState(false)
  const [adding, setAdding] = useState(null)
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    try {
      const context = await getAppContext()
      setCtx(context)
      const store = await supabase.from('stores').select('low_stock_alert').eq('id', context.storeId).single()
      const limit = Number.isFinite(Number(store.data?.low_stock_alert))
        ? Number(store.data.low_stock_alert)
        : DEFAULT_THRESHOLD
      setThreshold(limit)

      let query = supabase.from('inventory')
        .select('id, quantity, product_variants!inner(id, color, size, products!inner(name, tenant_id))')
        .eq('product_variants.products.tenant_id', context.tenantId)
        .lte('quantity', limit)
        .order('quantity', { ascending: true })
        .limit(50)
      query = scopeQuery(query, context)
      const rows = await fetchAllRows(query)
      setAlerts(rows)
      setError('')
    } catch (err) {
      setError(err.message || 'تعذر تحميل تنبيهات المخزون')
    }
  }, [])

  useEffect(() => { load() }, [load])

  const count = alerts.length

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen(value => !value)}
        aria-expanded={open}
        aria-label={`تنبيهات النواقص${count ? ` — ${count}` : ''}`}
        className="relative rounded-lg border border-white/10 bg-[#161616] px-3 py-2 text-sm text-neutral-300 hover:border-gold/40"
      >
        <span aria-hidden="true">🔔</span>
        {count > 0 && (
          <span className="absolute -end-1 -top-1 min-w-4 rounded-full bg-red-600 px-1 text-center text-[10px] font-bold text-white">
            {count}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute end-0 z-[70] mt-2 w-80 max-w-[90vw] rounded-xl border border-gold/20 bg-[#1A1A1A] p-3 shadow-xl">
          <p className="mb-2 text-xs text-neutral-400">
            النواقص (الحد: {threshold}) · {count}
          </p>
          {error && <p className="mb-2 text-xs text-red-300">{error}</p>}
          {!count ? (
            <p className="text-xs text-neutral-500">لا توجد أصناف تحت حد التنبيه.</p>
          ) : (
            <ul className="max-h-72 space-y-2 overflow-y-auto">
              {alerts.map(row => (
                <li key={row.id} className="rounded-lg border border-white/5 p-2">
                  <p className="text-xs text-neutral-200">{row.product_variants?.products?.name || 'منتج'}</p>
                  <p className="mt-0.5 text-[11px] text-neutral-500">
                    {row.product_variants?.color || 'بدون لون'} / {row.product_variants?.size || 'موحّد'} · متبقي {row.quantity}
                  </p>
                  <button
                    type="button"
                    onClick={() => { setAdding(row.product_variants?.id || ''); setOpen(false) }}
                    className="mt-1.5 rounded-md border border-gold/20 px-2 py-1 text-[11px] text-gold"
                  >
                    إضافة كمية
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      <ManualStockModal
        open={adding !== null}
        initialVariant={adding || ''}
        ctx={ctx}
        onClose={() => setAdding(null)}
        onSaved={load}
      />
    </div>
  )
}
