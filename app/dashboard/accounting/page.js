'use client'
import { useEffect, useState } from 'react'
import DashboardShell from '@/components/dashboard/DashboardShell'
import { useDashboardSession } from '@/components/dashboard/SessionProvider'
import { Notice, fieldClass, secondaryClass } from '@/components/dashboard/EngineUI'
import { supabase } from '@/lib/supabase'
import { formatDzd } from '@/lib/app-context'
import { accountingRange } from '@/lib/accounting'

export default function AccountingPage() {
  const ctx = useDashboardSession()
  const [period, setPeriod] = useState('month')
  const [version, setVersion] = useState(0)
  const [data, setData] = useState(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  useEffect(() => {
    let live = true
    setData(null); setError(''); setLoading(true)
    if (ctx.role !== 'owner') { setLoading(false); return }
    const { from, to } = accountingRange(period)
    supabase.rpc('engine_accounting', { p_store: ctx.storeId, p_from: from, p_to: to }).then(result => {
      if (result.error) throw result.error
      if (live) setData(result.data)
    }).catch(err => { if (live) setError(err.message) }).finally(() => { if (live) setLoading(false) })
    return () => { live = false }
  }, [ctx.role, ctx.storeId, period, version])
  const rows = data ? [
    ['إجمالي المبيعات', data.sales], ['إجمالي المصاريف', data.expenses],
    ['الرواتب', data.salaries], ['السلف', data.advances],
    ['إجمالي الأجور والسلف', Number(data.salaries) + Number(data.advances)],
    ['دفعات الموردين', data.supplierPayments], ['صافي الربح', data.netProfit],
  ] : []
  return <DashboardShell active="/dashboard/accounting"><div className="mx-auto max-w-5xl space-y-5">
    <h1 className="text-xl text-gold">المحاسبة للمالك</h1>
    <p className="text-sm text-neutral-400">{ctx.allBranches ? 'جميع الفروع' : ctx.stores.find(s => s.id === ctx.storeId)?.name} · القيم المسجلة على الخادم فقط. زامن المبيعات المحلية أولاً.</p>
    <div className="flex gap-3"><select aria-label="الفترة المحاسبية" className={`${fieldClass} max-w-xs`} value={period} onChange={e => setPeriod(e.target.value)}><option value="month">هذا الشهر</option><option value="year">هذه السنة</option><option value="all">كل الوقت</option></select><button className={secondaryClass} disabled={loading} onClick={() => setVersion(v => v + 1)}>تحديث</button></div>
    <Notice error={error} />{loading && <p className="text-neutral-400">جاري التحميل...</p>}
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">{rows.map(([label, value]) => <section key={label} className="rounded-2xl border border-gold/20 bg-card p-5"><h2 className="text-sm text-neutral-400">{label}</h2><p className="mt-3 text-2xl text-gold">{formatDzd(value)}</p></section>)}</div>
    <p className="text-sm leading-7 text-neutral-500">صافي الربح حسب المعادلة المطلوبة = المبيعات − (المصاريف + الرواتب + السلف). دفعات الموردين معروضة منفصلة ولا تُخصم مرة أخرى. هذا المؤشر لا يشمل تكلفة البضاعة أو المرتجعات أو الضرائب. المصاريف تشمل جميع الحالات المسجلة، وتاريخ الرواتب هو تاريخ الدفع لا شهر الاستحقاق.</p>
  </div></DashboardShell>
}
