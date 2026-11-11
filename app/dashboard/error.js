'use client'

import { useEffect } from 'react'

// Scoped boundary: a crash inside one dashboard screen keeps the shell intact
// and offers a route-level retry, which `reset()` re-renders in place.
export default function DashboardError({ error, reset }) {
  useEffect(() => { console.error('[dashboard] unhandled client error', error) }, [error])

  return <div className="p-4" dir="rtl">
    <section className="mx-auto max-w-lg rounded-2xl border border-gold/25 bg-[#171717] p-5 text-neutral-100">
      <h1 className="text-base font-medium text-gold">تعذر عرض هذه الشاشة</h1>
      <p className="mt-2 text-sm leading-6 text-neutral-300">
        حدث خطأ أثناء تحميل القسم. بقيت البيانات المحفوظة سليمة.
      </p>
      {typeof error?.message === 'string' && <p className="mt-3 break-words rounded-lg border border-white/10 bg-black/30 p-3 text-[11px] leading-5 text-neutral-400" dir="ltr">
        {error.message}
      </p>}
      <div className="mt-4 flex flex-wrap gap-2">
        <button type="button" onClick={() => reset()}
          className="rounded-lg bg-gold px-4 py-2.5 text-sm font-medium text-[#121212]">إعادة المحاولة</button>
        <button type="button" onClick={() => { window.location.href = '/dashboard' }}
          className="rounded-lg border border-white/10 px-4 py-2.5 text-sm text-neutral-300">لوحة التحكم</button>
      </div>
    </section>
  </div>
}
