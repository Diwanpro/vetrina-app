'use client'

// In-app «إشعار الطلب» for a newly arrived order. P5: beside the customer and
// order data it shows real product thumbnails resolved from order_items'
// image_url snapshot (or the embedded product for older rows). When the browser
// already granted the Notification API, a hidden tab also gets a system toast.

import { useEffect } from 'react'
import { orderItemImage } from '@/lib/orders'

function money(value) {
  const amount = Math.round(Number(value) || 0)
  return `\u2066${amount.toLocaleString('en-US')} دج\u2069`
}

export default function NewOrderNotice({ order, count = 1, onOpen, onDismiss }) {
  useEffect(() => {
    if (!order?.id || typeof window === 'undefined') return
    if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return
    if (document.visibilityState !== 'hidden') return
    const first = (order.order_items || []).map(orderItemImage).find(Boolean)
    try {
      new Notification('طلب جديد في Vetrina', {
        body: `${order.customer_name || 'زبون'} · ${order.order_number || ''} · ${money(order.total)}`,
        icon: first || undefined,
        tag: `vetrina-order-${order.id}`,
      })
    } catch { /* system notifications are best-effort only */ }
  }, [order?.id])

  if (!order) return null
  const images = (order.order_items || []).map(orderItemImage).filter(Boolean).slice(0, 4)
  const extra = Math.max(0, (order.order_items || []).length - images.length)

  return (
    <aside role="status" aria-label="إشعار طلب جديد"
      className="mb-3 rounded-xl border border-gold/35 bg-gold/10 p-3 text-neutral-100 shadow-lg">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-medium text-gold">
            🔔 {count > 1 ? `${count} طلبات جديدة` : 'طلب جديد وصل للتو'}
          </p>
          <p className="mt-1 truncate text-xs text-neutral-200">
            {order.order_number} · {order.customer_name || 'زبون'}
          </p>
          <p className="mt-0.5 text-[11px] text-neutral-400" dir="ltr">{order.customer_phone || ''}</p>
          <p className="mt-1 text-xs text-gold">{money(order.total)}</p>
        </div>
        <div dir="ltr" className="flex shrink-0 -space-x-2 space-x-reverse">
          {images.map((src, index) => (
            <img key={`${src}-${index}`} src={src} alt="صورة منتج في الطلب"
              className="h-12 w-12 rounded-lg border border-white/10 bg-black/40 object-cover" />
          ))}
          {extra > 0 && (
            <span className="flex h-12 w-12 items-center justify-center rounded-lg border border-white/10 bg-black/50 text-[11px] text-neutral-300">+{extra}</span>
          )}
          {!images.length && (
            <span className="flex h-12 w-12 items-center justify-center rounded-lg border border-white/10 bg-black/40 text-lg text-white/20">▦</span>
          )}
        </div>
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        <button type="button" onClick={() => onOpen?.(order)}
          className="rounded-lg bg-gold px-3 py-1.5 text-xs font-medium text-[#121212]">
          عرض تفاصيل الطلب والصور
        </button>
        <button type="button" onClick={onDismiss}
          className="rounded-lg border border-white/10 px-3 py-1.5 text-xs text-neutral-300">
          إخفاء الإشعار
        </button>
      </div>
    </aside>
  )
}
