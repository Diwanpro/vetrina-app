'use client'

import { useEffect, useState } from 'react'
import { scopeQuery } from '@/lib/access'
import { supabase } from '@/lib/supabase'
import { getAppContext, formatDzd } from '@/lib/app-context'
import { fetchAllRows } from '@/lib/cash'
import { sevenDayRange, sevenDaySales } from '@/lib/engine'

export default function SalesChart() {
  const [days, setDays] = useState(() => sevenDaySales())
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  useEffect(() => {
    let cancelled = false
    let inFlight = false
    async function load() {
      if (inFlight) return
      inFlight = true
      try {
        const ctx = await getAppContext()
        if (!ctx.storeIds.length || !ctx.tenantId) throw new Error('تعذر تحديد المتجر')
        const now = new Date()
        const { from, to } = sevenDayRange(now)
        const rows = await fetchAllRows(scopeQuery(supabase.from('sales').select('id, total_amount, created_at, stores!inner(tenant_id)')
          .gte('created_at', from).lt('created_at', to).order('id'), ctx))
        if (!cancelled) { setDays(sevenDaySales(rows, now)); setError('') }
      } catch (err) { if (!cancelled) setError(err.message) }
      finally { inFlight = false; if (!cancelled) setLoading(false) }
    }
    load()
    const timer = setInterval(load, 60000)
    window.addEventListener('focus', load)
    return () => { cancelled = true; clearInterval(timer); window.removeEventListener('focus', load) }
  }, [])
  const max = Math.max(1, ...days.map(day => day.value))
  return (
    <section className="rounded-xl border border-white/5 bg-card p-3.5 shadow-[0_4px_18px_rgba(0,0,0,0.28)]">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-medium text-neutral-100">مبيعات آخر 7 أيام</h2>
        <span className="text-[11px] text-neutral-500">{loading ? 'جاري التحميل...' : 'حسب تاريخ المتجر المحلي · دج'}</span>
      </div>
      {error && <p role="alert" className="mb-3 text-sm text-red-300">تعذر تحديث الرسم: {error}</p>}
      <div className="flex items-end justify-between gap-1.5 px-1">
        {days.map(day => (
          <div key={day.date} className="flex min-w-0 flex-1 flex-col items-center" title={`${day.date}: ${formatDzd(day.value)}`}>
            <span className="mb-1 text-[10px] text-gold">{day.value.toLocaleString('ar-DZ')}</span>
            <div className="flex h-32 w-full items-end justify-center">
              <div role="img" aria-label={`${day.label} ${day.date}: ${formatDzd(day.value)}`}
                className="w-full max-w-[28px] rounded-t-md bg-gradient-to-t from-[#8a7020] to-gold"
                style={{ height: `${(day.value / max) * 100}%` }} />
            </div>
            <span className="mt-2 text-[9px] sm:text-xs text-neutral-400">{day.label}</span>
            <span className="mt-1 text-[9px] text-neutral-600" dir="ltr">{day.date.slice(5)}</span>
          </div>
        ))}
      </div>
    </section>
  )
}
