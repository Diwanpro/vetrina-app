'use client'

import { useCallback, useEffect, useState } from 'react'
import { supabase } from '@/lib/supabase'
import { formatMoney, timelineFor, statusLabel } from '@/lib/storefront'
import { wilayaName } from '@/lib/wilayas'

function formatDate(value) {
  if (!value) return ''
  try {
    return new Date(value).toLocaleString('ar-DZ', {
      day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit',
    })
  } catch { return '' }
}

export default function TrackOrder({ slug, token }) {
  const [status, setStatus] = useState('loading')
  const [order, setOrder] = useState(null)
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    setStatus('loading')
    try {
      const { data, error: rpcError } = await supabase.rpc('get_order_by_token', { p_token: token })
      if (rpcError) throw rpcError
      if (!data) { setStatus('missing'); return }
      setOrder(data)
      setStatus('ready')
    } catch (err) {
      setError(err.message || 'تعذر تحميل الطلب')
      setStatus('error')
    }
  }, [token])

  useEffect(() => { load() }, [load])

  if (status === 'loading') {
    return (
      <main className="mx-auto max-w-lg px-4 pt-10">
        <div className="sf-skeleton h-8 w-40 rounded-lg" />
        <div className="sf-skeleton mt-4 h-56 rounded-3xl" />
      </main>
    )
  }

  if (status === 'missing') {
    return (
      <main className="flex min-h-screen flex-col items-center justify-center px-6 text-center">
        <p className="text-4xl">🔍</p>
        <h1 className="mt-4 text-lg font-bold text-neutral-100">لم نجد هذا الطلب</h1>
        <p className="mt-2 max-w-[32ch] text-sm text-neutral-400">
          تأكد من رابط التتبع. إن كان الرابط صحيحاً فقد يكون الطلب قد حُذف.
        </p>
      </main>
    )
  }

  if (status === 'error') {
    return (
      <main className="flex min-h-screen flex-col items-center justify-center px-6 text-center">
        <p className="text-neutral-200">تعذر تحميل الطلب</p>
        <p className="mt-2 text-sm text-neutral-500">{error}</p>
        <button type="button" onClick={load} className="mt-6 min-h-12 rounded-2xl bg-gold px-6 text-sm font-bold text-[#121212]">
          إعادة المحاولة
        </button>
      </main>
    )
  }

  const steps = timelineFor(order.status)
  const terminal = order.status === 'rejected' || order.status === 'cancelled'

  return (
    <main className="mx-auto max-w-lg px-4 pb-16 pt-8">
      <a href={`/s/${encodeURIComponent(slug || '')}`} className="text-xs text-neutral-500">
        ← العودة للمتجر
      </a>

      <div className="sf-fade-up mt-4 rounded-3xl border border-white/10 bg-gradient-to-br from-[#1d1a12] to-[#141414] p-5">
        <p className="text-[11px] uppercase tracking-[0.2em] text-gold/70">{order.store_name || 'طلب'}</p>
        <h1 className="mt-2 text-xl font-bold text-neutral-50">
          {terminal ? statusLabel(order.status) : `طلبك ${statusLabel(order.status)}`}
        </h1>
        <p className="mt-1 text-sm text-neutral-400" dir="ltr">{order.order_number}</p>
        <div className="mt-4 flex items-center justify-between border-t border-white/10 pt-3 text-sm">
          <span className="text-neutral-400">الإجمالي</span>
          <span className="font-bold text-gold">{formatMoney(order.total)}</span>
        </div>
        <p className="mt-1 text-[11px] text-neutral-500">
          {order.fulfillment_type === 'pickup' ? 'استلام من المحل' : 'توصيل'}
          {order.wilaya_code ? ` · ${wilayaName(order.wilaya_code) || order.wilaya_code}` : ''}
          {order.payment_method === 'cod' ? ' · الدفع عند الاستلام' : ''}
        </p>
      </div>

      {order.rejected_reason && (
        <p className="mt-3 rounded-2xl border border-red-500/30 bg-red-950/30 px-4 py-3 text-sm text-red-200">
          {order.rejected_reason}
        </p>
      )}

      <section aria-label="حالة الطلب" className="mt-6">
        <ol className="relative space-y-1 ps-2">
          {steps.map((step, index) => {
            const done = step.state === 'done'
            const current = step.state === 'current'
            const last = index === steps.length - 1
            return (
              <li key={step.key} className="relative flex gap-4 pb-6">
                {!last && (
                  <span
                    aria-hidden="true"
                    className={`absolute start-[13px] top-7 h-full w-px ${done ? 'bg-gold/50' : 'bg-white/10'}`}
                  />
                )}
                <span
                  className={`relative z-10 mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full border text-[11px] font-bold ${
                    done
                      ? 'border-gold/50 bg-gold/20 text-gold'
                      : current
                        ? 'border-gold bg-gold text-[#121212] shadow-[0_0_18px_rgba(212,175,55,0.45)]'
                        : 'border-white/15 bg-[#1a1a1a] text-neutral-500'
                  }`}
                >
                  {done ? '✓' : index + 1}
                </span>
                <div className="min-w-0 pt-0.5">
                  <p className={`text-sm font-medium ${current ? 'text-gold' : done ? 'text-neutral-200' : 'text-neutral-500'}`}>
                    {step.label}
                  </p>
                  <p className="mt-0.5 text-[11px] text-neutral-500">{step.hint}</p>
                </div>
              </li>
            )
          })}
        </ol>
      </section>

      <section aria-label="منتجات الطلب" className="mt-2">
        <h2 className="mb-2 text-sm font-medium text-neutral-300">المنتجات</h2>
        <ul className="space-y-2">
          {(order.items || []).map((item, index) => (
            <li key={index} className="flex items-center justify-between gap-3 rounded-2xl border border-white/10 bg-white/[0.03] p-3">
              <div className="min-w-0">
                <p className="truncate text-sm text-neutral-100">{item.product_name}</p>
                <p className="mt-0.5 text-[11px] text-neutral-500">
                  {[item.size, item.color].filter(Boolean).join(' · ') || 'مقاس موحّد'} · × {item.qty}
                </p>
              </div>
              <span className="shrink-0 text-sm font-bold text-gold">{formatMoney(item.line_total)}</span>
            </li>
          ))}
        </ul>
      </section>

      {Array.isArray(order.history) && order.history.length > 0 && (
        <p className="mt-6 text-center text-[11px] text-neutral-600">
          آخر تحديث: {formatDate(order.history[order.history.length - 1]?.at)}
        </p>
      )}

      <button
        type="button"
        onClick={load}
        className="mt-6 flex min-h-12 w-full items-center justify-center rounded-2xl border border-white/10 text-sm text-neutral-300 active:scale-[0.99]"
      >
        تحديث الحالة
      </button>
    </main>
  )
}
