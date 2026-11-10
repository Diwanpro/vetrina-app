'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { supabase } from '@/lib/supabase'
import { validateSignup } from '@/lib/trial'
import { fieldClass, primaryClass } from '@/components/dashboard/EngineUI'

// Public page: no auth required to render. The auth account is created by
// GoTrue, then engine_create_trial_tenant builds tenant/store/owner inside one
// SECURITY DEFINER transaction (tenants has RLS with no policies, so a browser
// insert is not possible by design).
export default function SignupPage() {
  const router = useRouter()
  const [form, setForm] = useState({ storeName: '', ownerName: '', phone: '', password: '' })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  const set = key => event => setForm(current => ({ ...current, [key]: event.target.value }))

  async function submit(event) {
    event.preventDefault()
    if (busy) return
    setBusy(true); setError(''); setNotice('')
    try {
      const clean = validateSignup(form)

      const { data: signUpData, error: signUpError } = await supabase.auth.signUp({
        email: clean.email,
        password: clean.password,
      })
      if (signUpError) throw new Error(signUpError.message.includes('already') ? 'رقم الهاتف مسجل بالفعل. جرّب تسجيل الدخول.' : signUpError.message)

      // Normally autoconfirm returns a session straight away. If confirmation
      // is ever switched back on, sign in explicitly rather than leaving the
      // user with an auth account and no tenant.
      if (!signUpData?.session) {
        const { error: signInError } = await supabase.auth.signInWithPassword({ email: clean.email, password: clean.password })
        if (signInError) throw new Error('تم إنشاء الحساب لكنه يحتاج تأكيداً. تواصل مع الدعم لإكمال التسجيل.')
      }

      const { data, error: rpcError } = await supabase.rpc('engine_create_trial_tenant', {
        p_store_name: clean.storeName,
        p_owner_name: clean.ownerName,
        p_phone: clean.phone,
      })
      if (rpcError) throw rpcError
      if (!data?.ok) throw new Error(data?.error || 'تعذر إنشاء الحساب')

      setNotice('تم إنشاء حسابك. جاري تحويلك إلى لوحة التحكم...')
      // Full navigation so the dashboard loads a brand-new context instead of
      // any state left over on this page.
      router.replace('/dashboard')
      router.refresh()
    } catch (err) {
      setError(err.message)
    } finally { setBusy(false) }
  }

  return (
    <main className="relative flex min-h-screen flex-col items-center justify-center bg-surface px-4 py-8">
      <div className="w-full max-w-md">
        <form onSubmit={submit} className="rounded-2xl border border-white/5 bg-card px-5 py-8 shadow-[0_8px_32px_rgba(0,0,0,0.45)]">
          <div className="mb-7 flex flex-col items-center">
            <img src="/logo.png" alt="Vetrina" width="180" height="98" className="mx-auto block h-auto w-auto max-h-[110px] max-w-[180px] bg-transparent object-contain" />
            <h1 className="mt-4 text-center text-lg text-gold">ابدأ تجربتك المجانية</h1>
            <p className="mt-1 text-[10px] tracking-[0.28em] uppercase text-neutral-500">7 DAYS · NO CARD REQUIRED</p>
          </div>

          <div className="space-y-4">
            <label className="block text-sm text-neutral-300">اسم المحل
              <input required maxLength={200} disabled={busy} value={form.storeName} onChange={set('storeName')} className={`${fieldClass} mt-1.5`} />
            </label>
            <label className="block text-sm text-neutral-300">اسم المالك
              <input required maxLength={200} disabled={busy} value={form.ownerName} onChange={set('ownerName')} className={`${fieldClass} mt-1.5`} />
            </label>
            <label className="block text-sm text-neutral-300">رقم الهاتف
              <input dir="ltr" inputMode="tel" autoComplete="tel" required maxLength={20} disabled={busy} placeholder="0555 12 34 56" value={form.phone} onChange={set('phone')} className={`${fieldClass} mt-1.5`} />
              <span className="mt-1 block text-[11px] text-neutral-500">يُستخدم لتسجيل الدخول لاحقاً (بدون حاجة لبريد إلكتروني)</span>
            </label>
            <label className="block text-sm text-neutral-300">كلمة المرور
              <input type="password" autoComplete="new-password" required minLength={8} maxLength={72} disabled={busy} value={form.password} onChange={set('password')} className={`${fieldClass} mt-1.5`} />
              <span className="mt-1 block text-[11px] text-neutral-500">8 أحرف على الأقل</span>
            </label>
          </div>

          {error && <p role="alert" className="mt-4 rounded-lg border border-red-500/30 bg-red-950/90 px-3 py-2 text-sm text-red-200">{error}</p>}
          {notice && <p role="status" className="mt-4 rounded-lg border border-emerald-700/40 bg-emerald-950/40 px-3 py-2 text-sm text-emerald-300">{notice}</p>}

          <button disabled={busy} className={`${primaryClass} mt-6 w-full`}>
            {busy ? 'جاري إنشاء الحساب...' : 'ابدأ تجربتك المجانية 7 أيام'}
          </button>

          <p className="mt-5 text-center text-xs text-neutral-500">
            لديك حساب بالفعل؟ <a href="/login" className="text-gold underline hover:text-[#c4a030]">تسجيل الدخول</a>
          </p>
        </form>

        <p className="mt-4 text-center text-[11px] text-neutral-500">
          للدعم: 0798726063 | attiawebsite@gmail.com
        </p>
      </div>
    </main>
  )
}
