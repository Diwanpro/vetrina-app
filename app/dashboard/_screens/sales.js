'use client'

import { useEffect, useState } from 'react'
import { scopeQuery } from '@/lib/access'
import { fetchAllRows } from '@/lib/cash'
import { localRows, belongsTo } from '@/lib/local-db'
import { supabase } from '@/lib/supabase'
import { formatDzd, getAppContext } from '@/lib/app-context'

const PAYMENT_LABELS = {
  cash: 'نقداً',
  check: 'شيك',
  ccp: 'CCP',
  credit: 'كريدي',
}

function formatDate(value) {
  if (!value) return '—'
  return new Date(value).toLocaleString('ar-DZ', {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function shortId(id) {
  return `#${String(id || '').slice(0, 8)}`
}

export default function SalesPage() {
  const [sales, setSales] = useState([])
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [selected, setSelected] = useState(null)
  const [items, setItems] = useState([])
  const [itemsLoading, setItemsLoading] = useState(false)

  useEffect(() => {
    let cancelled = false

    async function load() {
      try {
        const ctx = await getAppContext()
        const local = (await localRows()).filter(row => row.kind === 'sale' && belongsTo(row, ctx))
        const rows = navigator.onLine ? await fetchAllRows(scopeQuery(supabase.from('sales')
          .select('id, local_id, total_amount, payment_method, created_at, status, stores!inner(tenant_id)')
          .order('created_at', { ascending: false }).order('id'), ctx)) : []
        const pending = local.filter(row => !navigator.onLine || (row.status !== 'synced' && !rows.some(sale => sale.local_id === row.local_id)))
          .map(row => ({ ...row, id: row.local_id, localRecord: row }))
        if (!cancelled) setSales([...pending, ...rows])
      } catch (err) { if (!cancelled) setError(err.message) }
      finally { if (!cancelled) setLoading(false) }
    }

    load()
    return () => {
      cancelled = true
    }
  }, [])

  async function openSale(sale) {
    setSelected(sale)
    setItemsLoading(true)
    setError('')
    try {
      if (sale.localRecord) {
        setItems(sale.localRecord.items.map((item, index) => ({ ...item, id: index, product_variants: { color: item.color, size: item.size, products: { name: item.name || 'مقاس محفوظ محلياً' } } })))
      } else {
        const ctx = await getAppContext()
        const data = await fetchAllRows(scopeQuery(supabase.from('sale_items')
          .select('id, quantity, final_price, original_price, sales!inner(store_id, stores!inner(tenant_id)), product_variants!inner(size, color, products!inner(name, tenant_id))')
          .eq('sale_id', sale.id).eq('product_variants.products.tenant_id', ctx.tenantId).order('id'), ctx, 'sales.store_id', 'sales.stores.tenant_id'))
        setItems(data)
      }
    } catch (err) { setError(err.message); setItems([]) }
    finally { setItemsLoading(false) }
  }

  return (
    <>
      <div className="mb-3">
        <h1 className="text-base font-medium text-neutral-100">المبيعات</h1>
        <p className="text-xs text-neutral-500">{sales.length} فاتورة</p>
      </div>

      {error && <p role="alert" className="mb-3 text-sm text-red-300">{error}</p>}
      {loading ? (
        <p className="text-sm text-neutral-500">جاري التحميل...</p>
      ) : sales.length === 0 ? (
        <div className="rounded-xl border border-dashed border-white/10 bg-card p-8 text-center">
          <p className="text-sm text-neutral-300">لا توجد مبيعات بعد</p>
        </div>
      ) : (
        <div className="space-y-2">
          {sales.map((sale) => (
            <button
              key={sale.id}
              type="button"
              onClick={() => openSale(sale)}
              className="w-full rounded-xl border border-white/5 bg-card p-3 text-right"
            >
              <div className="flex items-center justify-between gap-2">
                <span className="text-sm font-medium text-neutral-100">{shortId(sale.id)} {sale.localRecord && <span className="text-xs text-amber-300">· {sale.status === 'synced' ? 'محلي' : 'بانتظار المزامنة'}</span>}</span>
                <span className="text-sm font-bold text-gold">{formatDzd(sale.total_amount)}</span>
              </div>
              <div className="mt-1 flex items-center justify-between text-[11px] text-neutral-500">
                <span>{formatDate(sale.created_at)}</span>
                <span>{PAYMENT_LABELS[sale.payment_method] || sale.payment_method || '—'}</span>
              </div>
            </button>
          ))}
        </div>
      )}

      {selected && (
        <div className="fixed inset-0 z-50 bg-black/70 flex items-end md:items-center justify-center p-0 md:p-4">
          <div className="w-full max-w-md rounded-t-2xl md:rounded-2xl bg-[#171717] border border-white/10 p-4">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-sm font-medium">تفاصيل الفاتورة {shortId(selected.id)}</h2>
              <button type="button" onClick={() => setSelected(null)} className="text-xs text-neutral-400">
                إغلاق
              </button>
            </div>
            <p className="mb-3 text-xs text-neutral-500">
              {formatDate(selected.created_at)} · {PAYMENT_LABELS[selected.payment_method] || selected.payment_method}
            </p>
            {itemsLoading ? (
              <p className="text-sm text-neutral-500">جاري التحميل...</p>
            ) : items.length === 0 ? (
              <p className="text-sm text-neutral-500">لا توجد عناصر</p>
            ) : (
              <ul className="space-y-2">
                {items.map((item) => (
                  <li key={item.id} className="flex items-center justify-between rounded-lg bg-[#1f1f1f] px-3 py-2">
                    <div>
                      <p className="text-sm text-neutral-100">
                        {item.product_variants?.products?.name || 'منتج'}
                      </p>
                      <p className="text-[11px] text-neutral-500">
                        {item.product_variants?.color} / {item.product_variants?.size} × {item.quantity}
                      </p>
                    </div>
                    <span className="text-sm text-gold">{formatDzd(item.final_price * item.quantity)}</span>
                  </li>
                ))}
              </ul>
            )}
            <p className="mt-3 text-base font-bold text-gold">الإجمالي: {formatDzd(selected.total_amount)}</p>
          </div>
        </div>
      )}
    </>
  )
}
