'use client'

import { trialDaysLeft, trialExpired } from '@/lib/access'
import { whatsappLink, WHATSAPP_NUMBER } from '@/lib/trial'
import ActivationForm from '@/components/dashboard/ActivationForm'

// Full-screen lock for owners whose 7-day trial has ended without a license.
// Rendered by SessionProvider *before* any dashboard child mounts, so the POS
// and every other screen are genuinely unreachable, not merely hidden.
export default function TrialCheck({ tenant, role, onActivated }) {
  const expired = trialExpired(tenant)
  const daysLeft = trialDaysLeft(tenant)

  // Activated tenants and unexpired trials pass straight through.
  if (!expired) return null

  const message = `مرحباً Attia Web Solution، انتهت فترتي التجريبية في Vetrina وأرغب في شراء مفتاح التفعيل. اسم المحل: ${tenant?.name || ''}`

  return (
    <main className="flex min-h-screen flex-col items-center justify-center bg-surface px-4 py-10 text-neutral-100" role="alert">
      <div className="w-full max-w-lg rounded-2xl border border-gold/30 bg-card p-6 shadow-[0_8px_40px_rgba(0,0,0,0.55)]">
        <img src="/logo.png" alt="Vetrina" width="150" height="82" className="mx-auto mb-6 block h-auto w-auto max-h-[90px] max-w-[150px] bg-transparent object-contain" />

        <p className="mb-2 text-center text-[11px] tracking-[0.28em] text-gold">VETRINA · TRIAL</p>
        <h1 className="mb-3 text-center text-xl text-gold">انتهت فترتك التجريبية</h1>
        <p className="mb-6 text-center text-sm leading-relaxed text-neutral-400">
          انتهت فترتك التجريبية. يرجى التواصل مع Attia Web Solution لشراء مفتاح التفعيل.
        </p>

        <div className="mb-6 space-y-2 rounded-xl border border-white/5 bg-black/20 p-4 text-xs text-neutral-400">
          <p className="flex justify-between gap-3"><span>المحل</span><span className="text-neutral-200">{tenant?.name || '—'}</span></p>
          <p className="flex justify-between gap-3"><span>بداية التجربة</span><span className="text-neutral-200">{tenant?.trial_start_date ? new Date(tenant.trial_start_date).toLocaleDateString('ar-DZ') : '—'}</span></p>
          <p className="flex justify-between gap-3"><span>المدة</span><span className="text-neutral-200">7 أيام</span></p>
          <p className="flex justify-between gap-3"><span>المتبقي</span><span className="text-red-300">{daysLeft === null ? '—' : `${daysLeft} يوم`}</span></p>
        </div>

        <a href={whatsappLink(message)} target="_blank" rel="noreferrer"
          className="mb-3 flex w-full items-center justify-center gap-2 rounded-lg bg-[#25D366] px-4 py-3 text-sm font-medium text-[#0b1f12] transition hover:bg-[#1fbe5b]">
          <span aria-hidden="true">💬</span> تواصل عبر واتساب · {WHATSAPP_NUMBER}
        </a>

        {role === 'owner' ? (
          <details className="rounded-xl border border-gold/20 bg-black/20 p-4">
            <summary className="cursor-pointer text-sm text-gold">لديك مفتاح تفعيل؟</summary>
            <p className="mb-3 mt-2 text-xs text-neutral-500">أدخل المفتاح الذي حصلت عليه من Attia Web Solution. يُفعّل الحساب نهائياً بدون تاريخ انتهاء.</p>
            <ActivationForm onActivated={onActivated} />
          </details>
        ) : (
          <p className="rounded-lg border border-red-800/40 bg-red-950/20 p-3 text-center text-sm text-red-300">
            تواصل مع مالك الحساب لتفعيل الاشتراك.
          </p>
        )}

        <a href="/login" className="mt-5 block text-center text-xs text-neutral-500 underline hover:text-neutral-300">العودة لتسجيل الدخول</a>
      </div>
    </main>
  )
}
