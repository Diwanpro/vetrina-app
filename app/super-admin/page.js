'use client'

import { useCallback, useEffect, useState } from 'react'
import { LICENSE_TYPES, validateBranches } from '@/lib/licenses'
import { fieldClass, primaryClass, secondaryClass } from '@/components/dashboard/EngineUI'
import CustomSelect from '@/components/ui/CustomSelect'
import { supabase } from '@/lib/supabase'

const SESSION_KEY = 'vetrina.super-admin'

// Deliberately outside /dashboard: no Sidebar, no TopBar, no nav.
export default function SuperAdminPage() {
  const [password, setPassword] = useState('')
  const [authed, setAuthed] = useState(false)
  const [checking, setChecking] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  const [type, setType] = useState('activation')
  const [branches, setBranches] = useState('1')
  const [generated, setGenerated] = useState(null)
  const [licenses, setLicenses] = useState([])

  const load = useCallback(async pass => {
    const { data, error: rpcError } = await supabase.rpc('engine_admin_list_licenses', { p_password: pass, p_limit: 50 })
    if (rpcError) throw rpcError
    if (!data?.ok) throw new Error(data?.error || 'تعذر تحميل القائمة')
    setLicenses(data.licenses || [])
  }, [])

  // Re-check a password kept in sessionStorage so a refresh does not force a
  // re-login. It is revalidated by the database every time, never trusted.
  useEffect(() => {
    let live = true
    const stored = sessionStorage.getItem(SESSION_KEY)
    if (!stored) { setChecking(false); return }
    load(stored)
      .then(() => { if (live) { setPassword(stored); setAuthed(true) } })
      .catch(() => { if (live) sessionStorage.removeItem(SESSION_KEY) })
      .finally(() => { if (live) setChecking(false) })
    return () => { live = false }
  }, [load])

  async function unlock(event) {
    event.preventDefault()
    if (busy) return
    setBusy(true); setError(''); setNotice('')
    try {
      await load(password)
      sessionStorage.setItem(SESSION_KEY, password)
      setAuthed(true)
    } catch (err) { setError(err.message) }
    finally { setBusy(false) }
  }

  function lock() {
    sessionStorage.removeItem(SESSION_KEY)
    setAuthed(false); setPassword(''); setLicenses([]); setGenerated(null); setError(''); setNotice('')
  }

  async function generate(event) {
    event.preventDefault()
    if (busy) return
    setBusy(true); setError(''); setNotice(''); setGenerated(null)
    try {
      const count = validateBranches(branches)
      const { data, error: rpcError } = await supabase.rpc('engine_admin_generate_license', { p_password: password, p_type: type, p_branches: count })
      if (rpcError) throw rpcError
      if (!data?.ok) throw new Error(data?.error || 'تعذر توليد المفتاح')
      setGenerated(data)
      setNotice('تم توليد المفتاح وحفظه في قاعدة البيانات')
      await load(password)
    } catch (err) { setError(err.message) }
    finally { setBusy(false) }
  }

  async function copy(text) {
    try {
      await navigator.clipboard.writeText(text)
      setNotice('تم نسخ المفتاح')
    } catch { setError('تعذر النسخ. حدّد المفتاح يدوياً.') }
  }

  const shell = children => (
    <main className="relative flex min-h-screen flex-col items-center justify-center bg-surface px-4 py-8 text-neutral-100">
      <div className="w-full max-w-2xl">{children}</div>
      <button onClick={lock} className="mt-6 text-xs text-neutral-500 underline hover:text-neutral-300">خروج من لوحة الإدارة</button>
    </main>
  )

  if (checking) {
    return <main className="flex min-h-screen items-center justify-center bg-surface text-gold" role="status">جاري التحقق من الجلسة...</main>
  }

  if (!authed) {
    return (
      <main className="flex min-h-screen flex-col items-center justify-center bg-surface px-4">
        <form onSubmit={unlock} className="w-full max-w-sm rounded-2xl border border-gold/20 bg-card p-6 shadow-[0_8px_32px_rgba(0,0,0,0.45)]">
          <img src="/logo.png" alt="Vetrina" width="120" height="66" className="mx-auto mb-5 h-auto w-auto max-h-[90px] max-w-[160px] bg-transparent object-contain" />
          <h1 className="mb-1 text-center text-lg text-gold">لوحة الإدارة العليا</h1>
          <p className="mb-5 text-center text-[11px] tracking-[0.2em] text-neutral-500">ATTIA WEB SOLUTION</p>
          <label className="block text-sm text-neutral-300">كلمة المرور
            <input type="password" dir="ltr" autoComplete="off" required maxLength={200} disabled={busy}
              value={password} onChange={e => setPassword(e.target.value)} className={`${fieldClass} mt-2`} />
          </label>
          {error && <p role="alert" className="mt-3 rounded-lg border border-red-500/30 bg-red-950/90 px-3 py-2 text-sm text-red-200">{error}</p>}
          <button disabled={busy} className={`${primaryClass} mt-4 w-full`}>{busy ? 'جاري التحقق...' : 'دخول'}</button>
        </form>
      </main>
    )
  }

  return shell(
    <div className="space-y-5">
      <header className="rounded-2xl border border-gold/20 bg-card p-5">
        <h1 className="text-lg text-gold">لوحة الإدارة العليا</h1>
        <p className="mt-1 text-xs text-neutral-500">توليد مفاتيح الترخيص — Attia Web Solution</p>
      </header>

      <form onSubmit={generate} className="space-y-4 rounded-2xl border border-white/10 bg-card p-5">
        <h2 className="text-gold">مفتاح جديد</h2>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="text-sm text-neutral-300">نوع الترخيص
            <CustomSelect value={type} disabled={busy} onChange={e => setType(e)} options={Object.entries(LICENSE_TYPES).map(([value, label]) => ({ label, value }))} className={`${fieldClass} mt-1`} />
          </div>
          <label className="text-sm text-neutral-300">عدد الفروع
            <input dir="ltr" inputMode="numeric" required disabled={busy} value={branches}
              onChange={e => setBranches(e.target.value)} className={`${fieldClass} mt-1`} />
          </label>
        </div>
        {error && <p role="alert" className="rounded-lg border border-red-500/30 bg-red-950/90 px-3 py-2 text-sm text-red-200">{error}</p>}
        {notice && <p role="status" className="rounded-lg border border-emerald-700/40 bg-emerald-950/40 px-3 py-2 text-sm text-emerald-300">{notice}</p>}
        <button disabled={busy} className={primaryClass}>{busy ? 'جاري التوليد...' : 'Generate Key'}</button>
      </form>

      {generated && (
        <section className="rounded-2xl border border-gold/40 bg-card p-5">
          <h2 className="mb-2 text-gold">المفتاح المولّد</h2>
          <div className="flex flex-wrap items-center gap-3">
            <code dir="ltr" className="rounded-lg bg-black/40 px-3 py-2 font-mono text-lg tracking-[0.15em] text-gold">{generated.license_key}</code>
            <button onClick={() => copy(generated.license_key)} className={secondaryClass}>نسخ</button>
          </div>
          <p className="mt-2 text-xs text-neutral-500">{LICENSE_TYPES[generated.license_type]} · {generated.branches} فرع</p>
        </section>
      )}

      <section className="rounded-2xl border border-white/10 bg-card p-5">
        <div className="mb-3 flex items-center justify-between gap-3">
          <h2 className="text-gold">آخر المفاتيح · {licenses.length}</h2>
          <button disabled={busy} onClick={() => load(password).catch(err => setError(err.message))} className={secondaryClass}>تحديث</button>
        </div>
        {!licenses.length ? <p className="text-sm text-neutral-500">لا توجد مفاتيح بعد.</p> : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs" dir="ltr">
              <thead className="text-neutral-500">
                <tr><th className="py-2 pr-2">Key</th><th className="py-2 pr-2">Type</th><th className="py-2 pr-2">Branches</th><th className="py-2">Status</th></tr>
              </thead>
              <tbody>
                {licenses.map(row => (
                  <tr key={row.id} className="border-t border-white/5">
                    <td className="py-2 pr-2 font-mono text-neutral-200">
                      <button onClick={() => copy(row.license_key)} title="نسخ" className="hover:text-gold">{row.license_key}</button>
                    </td>
                    <td className="py-2 pr-2 text-neutral-400">{row.license_type}</td>
                    <td className="py-2 pr-2 text-neutral-400">{row.branches}</td>
                    <td className="py-2">
                      {row.is_used
                        ? <span className="rounded-full border border-red-800/40 bg-red-950/40 px-2 py-0.5 text-red-300">مستخدم</span>
                        : <span className="rounded-full border border-emerald-700/40 bg-emerald-950/40 px-2 py-0.5 text-emerald-300">غير مستخدم</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  )
}
