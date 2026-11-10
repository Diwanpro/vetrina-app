'use client'

import { createContext, useContext, useEffect, useState } from 'react'
import { usePathname } from 'next/navigation'
import { getAppContext } from '@/lib/app-context'
import { routeAllowed } from '@/lib/access'
import { syncPending } from '@/lib/sync'
import { supabase } from '@/lib/supabase'
import ActivationForm from './ActivationForm'

const SessionContext = createContext(null)
export function useDashboardSession() { return useContext(SessionContext) }
export default function SessionProvider({ children }) {
  const path = usePathname()
  const [ctx, setCtx] = useState(null)
  const [error, setError] = useState('')
  const [attendanceError, setAttendanceError] = useState('')
  useEffect(() => {
    let live = true
    async function refresh() {
      try { const value = await getAppContext(); if (live) { setCtx(value); setError('') } }
      catch (err) { if (live) { setCtx(null); setError(err.message) } }
    }
    refresh()
    window.addEventListener('online', refresh); window.addEventListener('focus', refresh); window.addEventListener('vetrina:auth', refresh)
    const timer = setInterval(refresh, 60000)
    if ('serviceWorker' in navigator && process.env.NODE_ENV === 'production') {
      navigator.serviceWorker.register('/sw.js').then(() => navigator.serviceWorker.ready).then(registration => {
        const urls = performance.getEntriesByType('resource').map(entry => entry.name).filter(url => url.includes('/_next/static/'))
        if (['/dashboard', '/dashboard/pos'].includes(location.pathname)) urls.push(location.href)
        registration.active?.postMessage({ type: 'CACHE_ASSETS', urls })
      }).catch(() => {})
    }
    return () => { live = false; clearInterval(timer); window.removeEventListener('online', refresh); window.removeEventListener('focus', refresh); window.removeEventListener('vetrina:auth', refresh) }
  }, [])
  useEffect(() => {
    if (!ctx || ctx.locked) return
    const sync = () => syncPending().catch(() => {})
    sync()
    window.addEventListener('online', sync)
    const timer = setInterval(sync, 30000)
    return () => { clearInterval(timer); window.removeEventListener('online', sync) }
  }, [ctx?.user.id, ctx?.locked])

  useEffect(() => {
    let live = true
    setAttendanceError('')
    if (!ctx || ctx.locked || ctx.offline || ctx.role === 'owner') return
    // Session entry (including login) and verified refresh retry attendance.
    // Attendance failure never blocks login, a sale, or the offline outbox.
    supabase.rpc('engine_mark_attendance', { p_staff: ctx.staffId }).then(({ error }) => {
      if (error) throw error
    }).catch(err => { if (live) setAttendanceError(`تعذر تسجيل الحضور: ${err.message}. ستتم إعادة المحاولة تلقائياً.`) })
    return () => { live = false }
  }, [ctx])

  if (error) return <div className="min-h-screen bg-surface p-8 text-neutral-100"><p role="alert" className="mb-4 text-red-300">{error}</p><a href="/login" className="text-gold">تسجيل الدخول</a><button onClick={() => location.reload()} className="mx-4 text-gold">إعادة المحاولة</button></div>
  if (!ctx) return <div className="min-h-screen bg-surface p-8 text-gold" role="status">جاري التحقق من الحساب والصلاحيات...</div>
  const blocked = !routeAllowed(ctx.role, path)
  const needsBranch = ctx.allBranches && !['/dashboard', '/dashboard/settings', '/dashboard/transfers', '/dashboard/users', '/dashboard/accounting'].includes(path)
  return <SessionContext.Provider value={ctx}>
    {attendanceError && !ctx.locked && <p role="alert" className="border-b border-amber-700/30 bg-[#211b12] px-4 py-2 text-sm text-amber-200">{attendanceError}</p>}
    {ctx.locked ? <main className="flex min-h-screen items-center justify-center bg-surface p-5 text-neutral-100"><section className="w-full max-w-lg rounded-2xl border border-gold/30 bg-card p-6"><p className="mb-3 text-sm text-gold">VETRINA · الاشتراك</p><h1 className="mb-3 text-xl">انتهت الفترة التجريبية</h1><p className="mb-6 text-sm text-neutral-400">الحساب مقفل. البيانات محفوظة؛ فعّل الحساب لاستئناف العمل.</p>{ctx.role === 'owner' ? <ActivationForm onActivated={() => location.reload()} /> : <p className="text-sm text-red-300">تواصل مع المالك لتفعيل الحساب.</p>}<a href="/login" className="mt-5 block text-xs text-neutral-500">العودة لتسجيل الدخول</a></section></main>
      : blocked ? <div className="min-h-screen bg-surface p-8 text-neutral-100"><p role="alert">غير مصرح لك بالوصول إلى هذه الصفحة.</p><a href="/dashboard" className="mt-4 block text-gold">العودة للوحة التحكم</a></div>
      : needsBranch ? <div className="min-h-screen bg-surface p-8 text-neutral-100"><p>اختر فرعاً محدداً من لوحة التحكم للعمل في هذه الصفحة.</p><a href="/dashboard" className="mt-4 block text-gold">اختيار الفرع</a></div>
      : <div key={`${ctx.user.id}:${ctx.staffId}:${ctx.role}:${ctx.tenantId}:${ctx.storeId || 'all'}`}>{children}</div>}
  </SessionContext.Provider>
}
