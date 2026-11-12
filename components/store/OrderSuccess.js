'use client'

import { formatMoney } from '@/lib/storefront'

/** The moment of relief: one clear confirmation, the number to quote, and tracking. */
export default function OrderSuccess({ slug, token, orderNumber, total, showPrices, onContinue }) {
  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-[#121212]/95 px-6 backdrop-blur-xl">
      <div className="sf-fade-up w-full max-w-sm text-center">
        <div className="sf-pop mx-auto flex h-20 w-20 items-center justify-center rounded-full border border-gold/40 bg-gold/10 shadow-[0_0_50px_rgba(212,175,55,0.25)]">
          <svg viewBox="0 0 24 24" className="h-9 w-9 text-gold" fill="none" stroke="currentColor" strokeWidth="2.2" aria-hidden="true">
            <path d="m5 12.5 4.5 4.5L19 7.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </div>

        <h1 className="mt-6 text-2xl font-bold text-neutral-50">تم استلام طلبك بنجاح</h1>
        <p className="mt-2 text-sm leading-relaxed text-neutral-400">
          سنتصل بك على رقمك لتأكيد الطلب. الدفع عند الاستلام.
        </p>

        {orderNumber && (
          <div className="mt-5 rounded-2xl border border-white/10 bg-white/[0.04] p-4">
            <p className="text-[11px] uppercase tracking-widest text-neutral-500">رقم الطلب</p>
            <p className="mt-1 text-lg font-bold tracking-wider text-gold" dir="ltr">{orderNumber}</p>
            {showPrices && total != null && (
              <p className="mt-1 text-xs text-neutral-400">الإجمالي: {formatMoney(total)}</p>
            )}
          </div>
        )}

        <a
          href={`/s/${encodeURIComponent(slug)}/track/${encodeURIComponent(token)}`}
          className="mt-6 flex min-h-14 w-full items-center justify-center rounded-2xl bg-gradient-to-l from-[#E8C55A] to-gold font-bold text-[#121212] shadow-[0_10px_30px_rgba(212,175,55,0.25)] active:scale-[0.98]"
        >
          تتبع طلبي
        </a>
        <button
          type="button"
          onClick={onContinue}
          className="mt-3 min-h-12 w-full rounded-2xl border border-white/10 text-sm text-neutral-300"
        >
          متابعة التسوق
        </button>
      </div>
    </div>
  )
}
