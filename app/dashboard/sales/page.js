'use client'

import { useEffect, useState } from 'react'
import DashboardShell from '@/components/dashboard/DashboardShell'
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
  const [loading, setLoading] = useState(true)
  const [selected, setSelected] = useState(null)
  const [items, setItems] = useState([])
  const [itemsLoading, setItemsLoading] = useState(false)

  useEffect(() => {
    let cancelled = false

    async function load() {
      const ctx = await getAppContext()
      let query = supabase
        .from('sales')
        .select('id, total_amount, payment_method, created_at, status')
        .order('created_at', { ascending: false })
      if (ctx.storeId) query = query.eq('store_id', ctx.storeId)
      const { data } = await query
      if (!cancelled) {
        setSales(data || [])
        setLoading(false)
      }
    }

    load()
    return () => {
      cancelled = true
    }
  }, [])

  async function openSale(sale) {
    setSelected(sale)
    setItemsLoading(true)
    const { data } = await supabase
      .from('sale_items')
      .select('id, quantity, final_price, original_price, product_variants(size, color, products(name))')
      .eq('sale_id', sale.id)
    setItems(data || [])
    setItemsLoading(false)
  }

  return (
    <DashboardShell active="/dashboard/sales">
      <div className="mb-3">
        <h1 className="text-base font-medium text-neutral-100">المبيعات</h1>
        <p className="text-xs text-neutral-500">{sales.length} فاتورة</p>
      </div>

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
                <span className="text-sm font-medium text-neutral-100">{shortId(sale.id)}</span>
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
    </DashboardShell>
  )
}
