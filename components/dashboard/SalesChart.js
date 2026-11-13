'use client'

import { useEffect, useState } from 'react'
import { scopeQuery } from '@/lib/access'
import { supabase } from '@/lib/supabase'
import { getAppContext, formatDzd } from '@/lib/app-context'
import { fetchAllRows } from '@/lib/cash'
import { sevenDayBreakdown, sevenDayRange } from '@/lib/engine'
import { Modal } from '@/components/dashboard/EngineUI'

// One row in the drill-down. Kept local because the shape (label, amount) is
// specific to this modal.
function DayLine({ label, value, accent = 'text-neutral-100' }) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-white/5 px-3 py-2.5 last:border-0">
      <span className="text-sm text-neutral-300">{label}</span>
      <span className={`text-sm font-medium tabular-nums ${accent}`}>{value}</span>
    </div>
  )
}

// The day the user clicked. Everything here comes from the same rows the chart
// was drawn from, so the numbers cannot disagree with the bar height.
function DayModal({ day, onClose }) {
  if (!day) return null
  const [y, m, d] = day.date.split('-')
  return (
    <Modal title={`تفصيل يوم ${day.label}`} onClose={onClose}>
      <p className="mb-4 text-xs text-neutral-400" dir="ltr">{`${y}/${m}/${d}`}</p>

      <div className="mb-4 rounded-xl border border-gold/20 bg-gold/5 p-3.5">
        <p className="text-xs text-neutral-400">إجمالي المبيعات</p>
        <p className="mt-1 text-xl font-bold text-gold">{formatDzd(day.value)}</p>
        <p className="mt-1 text-xs text-neutral-500">{day.invoices} فاتورة</p>
      </div>

      <div className="rounded-xl border border-white/5 bg-black/20">
        <DayLine label="نقداً (دخل الصندوق)" value={formatDzd(day.cash)} accent="text-emerald-300" />
        <DayLine label="كريدي (على الحساب)" value={formatDzd(day.credit)} accent="text-red-300" />
        <DayLine label="شيك / CCP" value={formatDzd(day.check)} accent="text-amber-300" />
      </div>

      {/* The three parts are derived from the same invoice totals, so they must
          add back up. If they ever don't, the cause is a bad cash_amount, and
          saying so is better than showing a silent discrepancy. */}
      {day.cash + day.credit + day.check !== day.value ? (
        <p role="alert" className="mt-3 rounded-lg border border-amber-700/30 bg-amber-950/20 p-3 text-xs leading-6 text-amber-200">
          مجموع الأجزاء لا يساوي الإجمالي. غالباً مبلغ نقدي مسجّل أكبر من الفاتورة نفسها.
        </p>
      ) : null}
    </Modal>
  )
}

export default function SalesChart() {
  const [days, setDays] = useState(() => sevenDayBreakdown())
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [selected, setSelected] = useState(null)

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
        // cash_amount and payment_method are what split the day. Without them
        // the modal could only show a total.
        const rows = await fetchAllRows(scopeQuery(supabase.from('sales')
          .select('id, total_amount, cash_amount, payment_method, created_at, stores!inner(tenant_id)')
          .gte('created_at', from).lt('created_at', to).order('id'), ctx))
        if (!cancelled) { setDays(sevenDayBreakdown(rows, now)); setError('') }
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
        <span className="text-[11px] text-neutral-500">
          {loading ? 'جاري التحميل...' : 'اضغط على أي عمود لعرض التفصيل · دج'}
        </span>
      </div>
      {error && <p role="alert" className="mb-3 text-sm text-red-300">تعذر تحديث الرسم: {error}</p>}
      <div className="flex items-end justify-between gap-1.5 px-1">
        {days.map(day => (
          // A button, not a div: the bar is the control, so it must be
          // reachable and activatable without a mouse.
          <button
            key={day.date}
            type="button"
            onClick={() => setSelected(day)}
            aria-haspopup="dialog"
            aria-label={`${day.label} ${day.date}: ${formatDzd(day.value)} — عرض التفصيل`}
            className="group flex min-w-0 flex-1 flex-col items-center rounded-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-gold/60"
            title={`${day.date}: ${formatDzd(day.value)}`}
          >
            <span className="mb-1 text-[10px] text-gold">{day.value.toLocaleString('ar-DZ')}</span>
            <div className="flex h-32 w-full items-end justify-center">
              <div
                aria-hidden="true"
                className="w-full max-w-[28px] rounded-t-md bg-gradient-to-t from-[#8a7020] to-gold transition group-hover:from-gold group-hover:to-[#ffe9a8]"
                // 0 stays a hairline so an empty day is still clickable.
                style={{ height: day.value > 0 ? `${(day.value / max) * 100}%` : '2px' }}
              />
            </div>
            <span className="mt-2 text-[9px] sm:text-xs text-neutral-400">{day.label}</span>
            <span className="mt-1 text-[9px] text-neutral-600" dir="ltr">{day.date.slice(5)}</span>
          </button>
        ))}
      </div>
      <DayModal day={selected} onClose={() => setSelected(null)} />
    </section>
  )
}
