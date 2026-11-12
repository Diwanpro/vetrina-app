'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useDashboardSession } from '@/components/dashboard/SessionProvider'
import { Notice, Modal, secondaryClass } from '@/components/dashboard/EngineUI'
import { formatDzd } from '@/lib/app-context'
import { supabase } from '@/lib/supabase'
import { WILAYAS } from '@/lib/wilayas'
import { whatsappLink } from '@/lib/storefront'
import {
  ORDER_TABS, filterByTab, tabCounts, itemsCount, rejectedCustomers, nextStatuses,
  orderWhatsappMessage, phoneKey, shortDateTime, statusLabel, telLink,
} from '@/lib/orders'

const STATUS_TONE = {
  new: 'border-gold/40 bg-gold/10 text-gold',
  confirmed: 'border-sky-500/30 bg-sky-500/10 text-sky-200',
  preparing: 'border-violet-500/30 bg-violet-500/10 text-violet-200',
  delivered: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-200',
  rejected: 'border-red-500/30 bg-red-500/10 text-red-200',
  cancelled: 'border-white/15 bg-white/5 text-neutral-300',
}

const wilayaName = code => WILAYAS.find(entry => entry.code === code)?.name || ''

function OrderCard({ order, storeName, warning, busy, onStatus }) {
  const phone = telLink(order.customer_phone)
  const whatsapp = whatsappLink(order.customer_phone, orderWhatsappMessage(order, storeName))
  const moves = nextStatuses(order.status)
  const count = itemsCount(order)

  return (
    <article className="rounded-2xl border border-white/10 bg-card p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="flex flex-wrap items-center gap-2 text-sm font-bold text-neutral-100">
            <span dir="ltr" className="tabular-nums">{order.order_number}</span>
            <span className={`rounded-full border px-2 py-0.5 text-[10px] font-medium ${STATUS_TONE[order.status] || STATUS_TONE.cancelled}`}>
              {statusLabel(order.status)}
            </span>
            {warning && (
              <span className="rounded-full border border-red-500/40 bg-red-500/10 px-2 py-0.5 text-[10px] font-medium text-red-300">
                تحذير: رفض سابق
              </span>
            )}
          </p>
          <p className="mt-1 truncate text-sm text-neutral-200">{order.customer_name}</p>
          <p dir="ltr" className="text-start text-xs text-neutral-400">{order.customer_phone}</p>
        </div>
        <div className="shrink-0 text-end">
          <p className="text-sm font-bold text-gold">{formatDzd(order.total)}</p>
          <p className="text-[11px] text-neutral-500">{count} قطعة</p>
        </div>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-neutral-500">
        <span>{order.fulfillment_type === 'pickup' ? 'استلام من المحل' : 'توصيل'}</span>
        {order.wilaya_code && <span>{order.wilaya_code} — {wilayaName(order.wilaya_code)}</span>}
        {order.delivery_fee_on_arrival && <span className="text-amber-300">التوصيل يُدفع عند الاستلام</span>}
        <span>{shortDateTime(order.created_at)}</span>
      </div>

      {order.note && <p className="mt-2 rounded-lg bg-black/30 px-2 py-1.5 text-[11px] text-neutral-400">{order.note}</p>}
      {order.rejected_reason && <p className="mt-2 text-[11px] text-red-300">السبب: {order.rejected_reason}</p>}

      <div className="mt-3 flex flex-wrap gap-2">
        {phone && (
          <a href={phone} className={`${secondaryClass} min-h-9 px-3 text-xs`}>اتصال</a>
        )}
        <a
          href={whatsapp}
          target="_blank"
          rel="noopener noreferrer"
          className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-200"
        >
          واتساب
        </a>
        {moves.map(move => (
          <button
            key={move.key}
            type="button"
            disabled={busy}
            onClick={() => onStatus(order, move.key)}
            className={`min-h-9 rounded-lg px-3 text-xs font-medium disabled:opacity-50 ${
              move.destructive
                ? 'border border-red-500/30 bg-red-500/10 text-red-200'
                : 'bg-gold text-[#121212]'
            }`}
          >
            {move.label}
          </button>
        ))}
      </div>
    </article>
  )
}

export default function OrdersScreen() {
  const ctx = useDashboardSession()
  const [orders, setOrders] = useState([])
  const [tab, setTab] = useState('new')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')
  const [busyId, setBusyId] = useState('')
  const [pending, setPending] = useState(null)   // { order, status } awaiting a reason
  const [reason, setReason] = useState('')

  const storeNames = useMemo(() => {
    const map = new Map((ctx?.stores || []).map(store => [store.id, store.name]))
    return id => map.get(id) || ''
  }, [ctx?.stores])

  const load = useCallback(async () => {
    if (!ctx) return
    setLoading(true)
    try {
      // Owner on "all branches" works across the tenant; everyone else is
      // pinned to the branch they are signed in to (RLS agrees).
      let query = supabase
        .from('orders')
        .select('id, order_number, status, fulfillment_type, customer_name, customer_phone, wilaya_code, total, delivery_fee, delivery_fee_on_arrival, created_at, note, rejected_reason, store_id, order_items(qty)')
        .order('created_at', { ascending: false })
        .limit(300)
      query = ctx.allBranches ? query.eq('tenant_id', ctx.tenantId) : query.eq('store_id', ctx.storeId)
      const { data, error: queryError } = await query
      if (queryError) throw queryError
      setOrders(data || [])
      setError('')
    } catch (err) {
      setError(err.message || 'تعذر تحميل الطلبات')
    } finally {
      setLoading(false)
    }
  }, [ctx?.tenantId, ctx?.storeId, ctx?.allBranches])

  useEffect(() => { load() }, [load])

  const counts = useMemo(() => tabCounts(orders), [orders])
  const warned = useMemo(() => rejectedCustomers(orders), [orders])
  const visible = useMemo(() => filterByTab(orders, tab), [orders, tab])
  const newCount = counts.find(entry => entry.key === 'new')?.count || 0

  async function applyStatus(order, status, note = '') {
    setBusyId(order.id)
    setError('')
    setSuccess('')
    try {
      const { error: rpcError } = await supabase.rpc('update_order_status', {
        p_order_id: order.id,
        p_new_status: status,
        p_reason: note || null,
      })
      if (rpcError) throw rpcError
      setSuccess(`تم تحديث الطلب ${order.order_number} إلى «${statusLabel(status)}»`)
      setPending(null)
      setReason('')
      await load()
    } catch (err) {
      setError(err.message || 'تعذر تحديث الطلب')
    } finally {
      setBusyId('')
    }
  }

  function requestStatus(order, status) {
    // Refusing an order asks why; the reason is stored for the customer file.
    if (status === 'rejected' || status === 'cancelled') {
      setPending({ order, status })
      setReason('')
      return
    }
    applyStatus(order, status)
  }

  return (
    <section className="mx-auto max-w-3xl">
      <div className="mb-3 flex items-center justify-between gap-3">
        <h1 className="text-lg font-bold text-neutral-100">الطلبات</h1>
        <button type="button" onClick={load} disabled={loading} className={`${secondaryClass} min-h-9 px-3 text-xs`}>
          {loading ? 'تحديث...' : 'تحديث'}
        </button>
      </div>

      <Notice error={error} success={success} />

      <div className="sf-rail -mx-1 mb-3 flex gap-2 overflow-x-auto px-1 pb-1">
        {ORDER_TABS.map(entry => {
          const count = counts.find(item => item.key === entry.key)?.count || 0
          const active = tab === entry.key
          return (
            <button
              key={entry.key}
              type="button"
              onClick={() => setTab(entry.key)}
              aria-pressed={active}
              className={`flex min-h-10 shrink-0 items-center gap-1.5 rounded-full border px-3 text-xs transition ${
                active ? 'border-gold bg-gold/15 font-medium text-gold' : 'border-white/10 bg-white/5 text-neutral-300'
              }`}
            >
              {entry.label}
              <span className={`rounded-full px-1.5 text-[10px] ${
                active ? 'bg-gold/20 text-gold' : 'bg-white/10 text-neutral-400'
              }`}>{count}</span>
            </button>
          )
        })}
      </div>

      {loading && !orders.length ? (
        <p className="py-10 text-center text-sm text-neutral-500">جاري تحميل الطلبات...</p>
      ) : !visible.length ? (
        <div className="rounded-2xl border border-white/10 bg-card py-12 text-center">
          <p className="text-2xl">📦</p>
          <p className="mt-2 text-sm text-neutral-300">
            {newCount > 0 && tab === 'new' ? 'لا توجد طلبات جديدة' : 'لا توجد طلبات في هذه الحالة'}
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {visible.map(order => (
            <OrderCard
              key={order.id}
              order={order}
              storeName={storeNames(order.store_id)}
              // Only open orders carry the warning: a closed one *is* the refusal.
              warning={!['rejected', 'cancelled'].includes(order.status) && warned(phoneKey(order.customer_phone))}
              busy={busyId === order.id}
              onStatus={requestStatus}
            />
          ))}
        </div>
      )}

      {pending && (
        <Modal title={`${pending.status === 'rejected' ? 'رفض' : 'إلغاء'} الطلب ${pending.order.order_number}`} onClose={() => setPending(null)} busy={Boolean(busyId)}>
          <label className="block text-sm text-neutral-300">
            السبب (اختياري)
            <textarea
              rows={3}
              value={reason}
              onChange={event => setReason(event.target.value)}
              placeholder="مثال: الكمية غير متوفرة"
              className="mt-1 w-full rounded-lg border border-[#D4AF37]/40 bg-[#1A1A1A] px-3 py-2 text-sm text-white outline-none focus:border-gold"
            />
          </label>
          <div className="mt-4 flex justify-end gap-2">
            <button type="button" onClick={() => setPending(null)} disabled={Boolean(busyId)} className={secondaryClass}>
              إلغاء
            </button>
            <button
              type="button"
              disabled={Boolean(busyId)}
              onClick={() => applyStatus(pending.order, pending.status, reason.trim())}
              className={`rounded-lg px-4 py-2 text-sm font-medium text-[#121212] disabled:opacity-50 ${pending.status === 'rejected' ? 'bg-red-400' : 'bg-gold'}`}
            >
              {busyId ? 'جاري التنفيذ...' : 'تأكيد'}
            </button>
          </div>
        </Modal>
      )}
    </section>
  )
}
