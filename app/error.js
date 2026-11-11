'use client'

import { useEffect } from 'react'

// Global safety net for client-side exceptions. The till must never show a
// black screen: a render crash becomes a readable message with a way back.
// Note the file is `error.js` to match the project's JavaScript convention —
// Next.js treats it identically to `error.tsx`.
export default function GlobalError({ error, reset }) {
  useEffect(() => {
    // Keep the technical detail in the console for diagnosis; the user sees the
    // Arabic message below instead of a stack trace.
    console.error('[app] unhandled client error', error)
  }, [error])

  const detail = typeof error?.message === 'string' ? error.message : ''

  return <div className="flex min-h-screen items-center justify-center bg-surface p-4" dir="rtl">
    <section className="w-full max-w-md rounded-2xl border border-gold/25 bg-[#171717] p-6 text-neutral-100 shadow-2xl">
      <h1 className="text-lg font-medium text-gold">حدث خطأ غير متوقع</h1>
      <p className="mt-3 text-sm leading-6 text-neutral-300">
        توقف هذا الجزء من التطبيق. بياناتك المحفوظة لم تتأثر، ويمكنك إعادة المحاولة.
      </p>

      {detail && <p className="mt-3 break-words rounded-lg border border-white/10 bg-black/30 p-3 text-[11px] leading-5 text-neutral-400" dir="ltr">
        {detail}
      </p>}

      <div className="mt-5 flex flex-wrap gap-2">
        <button type="button" onClick={() => reset()}
          className="rounded-lg bg-gold px-4 py-2.5 text-sm font-medium text-[#121212]">
          إعادة المحاولة
        </button>
        <button type="button" onClick={() => { window.location.href = '/dashboard' }}
          className="rounded-lg border border-white/10 px-4 py-2.5 text-sm text-neutral-300">
          العودة للوحة التحكم
        </button>
        <button type="button" onClick={() => window.location.reload()}
          className="rounded-lg border border-white/10 px-4 py-2.5 text-sm text-neutral-300">
          إعادة تحميل الصفحة
        </button>
      </div>

      <p className="mt-4 text-[11px] leading-5 text-neutral-500">
        إذا تكرر الخطأ، أرسل النص أعلاه إلى الدعم وسنساعدك في تحديد السبب.
      </p>
    </section>
  </div>
}
