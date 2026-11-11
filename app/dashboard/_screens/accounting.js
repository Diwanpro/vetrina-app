'use client'
import { useEffect, useMemo, useState } from 'react'
import { useDashboardSession } from '@/components/dashboard/SessionProvider'
import { Notice, fieldClass, secondaryClass } from '@/components/dashboard/EngineUI'
import MoneyDistribution from '@/components/dashboard/MoneyDistribution'
import EmployeePayments from '@/components/dashboard/EmployeePayments'
import { supabase } from '@/lib/supabase'
import { formatDzd } from '@/lib/app-context'
import { accountingRange } from '@/lib/accounting'

const TYPES = { sale: 'بيع', expense: 'مصروف', payroll: 'راتب', advance: 'سلفة' }
export default function AccountingPage() {
  const ctx = useDashboardSession()
  const [period, setPeriod] = useState('month')
  const [version, setVersion] = useState(0)
  const [page, setPage] = useState(0)
  const [data, setData] = useState(null)
  const [journal, setJournal] = useState(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [costLines, setCostLines] = useState(null)
  const [costOpen, setCostOpen] = useState(false)
  const range = useMemo(() => accountingRange(period), [period, version])
  function refresh() { setPage(0); setVersion(v => v + 1) }
  useEffect(() => { window.addEventListener('vetrina:finance', refresh); return () => window.removeEventListener('vetrina:finance', refresh) }, [])
  useEffect(() => {
    let live = true
    setData(null); setJournal(null); setError(''); setLoading(true)
    if (ctx.role !== 'owner') { setLoading(false); return }
    const args = { p_store: ctx.storeId, p_from: range.from, p_to: range.to }
    const calls = [supabase.rpc('engine_accounting_commercial', args), supabase.rpc('engine_journal', { ...args, p_offset: page * 50 })]
    // Cost lines are optional detail: a failure there must never blank the page.
    calls.push(supabase.rpc('engine_accounting_cost_lines', { ...args, p_limit: 200 }))
    Promise.all(calls).then(([totals, entries, lines]) => {
      if (totals.error || entries.error) throw totals.error || entries.error
      if (live) { setData(totals.data); setJournal(entries.data); setCostLines(lines.error ? null : lines.data) }
    }).catch(err => { if (live) setError(err.message) }).finally(() => { if (live) setLoading(false) })
    return () => { live = false }
  }, [ctx.role, ctx.storeId, range, page])
  async function receipt(path) {
    const tab = window.open('about:blank', '_blank')
    if (tab) tab.opener = null
    try {
      const { data, error } = await supabase.storage.from('expense-receipts').createSignedUrl(path, 60)
      if (error) throw error
      if (tab) tab.location.href = data.signedUrl
      else throw new Error('اسمح بالنوافذ المنبثقة لعرض الإيصال')
    } catch (err) { tab?.close(); setError(err.message) }
  }
  // COGS and gross profit are shown explicitly: they were previously hidden,
  // which is why a runaway cost average could destroy net profit unnoticed.
  const cards = data ? [
    ['إجمالي المبيعات', data.sales],
    ['تكلفة البضاعة المباعة', data.costOfGoods],
    ['إجمالي المصاريف', data.expenses],
    ['الرواتب والسلف', Number(data.salaries) + Number(data.advances)],
    ['صافي الربح', data.netProfit],
  ] : []
  const costParts = data?.costBreakdown
  const costNote = costParts
    ? `${costParts.snapshot || 0} بند بتكلفة محفوظة وقت البيع · ${costParts.history || 0} بند أُعيد بناؤه من فواتير الشراء · ${costParts.current || 0} بند بمتوسط التكلفة الحالي`
    : ''
  return <><div className="mx-auto max-w-6xl space-y-5">
    <header><h1 className="text-xl text-gold">المحاسبة والمصاريف</h1><p className="mt-2 text-sm text-neutral-500">{ctx.allBranches ? 'جميع الفروع' : ctx.stores.find(s => s.id === ctx.storeId)?.name} · البيانات المتزامنة فقط. زر تسجيل المصروف متاح للجميع في الشريط العلوي.</p></header>
    <div className="flex gap-3"><select aria-label="الفترة المحاسبية" className={`${fieldClass} max-w-xs`} value={period} onChange={e => { setPeriod(e.target.value); setPage(0) }}><option value="month">هذا الشهر</option><option value="year">هذه السنة</option><option value="all">كل الوقت</option></select><button className={secondaryClass} disabled={loading} onClick={refresh}>تحديث</button></div>
    <Notice error={error} />{loading && <p className="text-neutral-400">جاري التحميل...</p>}
    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-5">{cards.map(([label, value]) => <section key={label} className="rounded-2xl border border-gold/20 bg-card p-5"><h2 className="text-sm text-neutral-400">{label}</h2><p className={`mt-3 break-words text-2xl ${Number(value) < 0 ? 'text-red-300' : 'text-gold'}`}>{formatDzd(value)}</p></section>)}</div>
    {data && costNote && <p className="text-xs text-neutral-500">تفصيل تكلفة المبيعات: {costNote}. تُحسب التكلفة من البنود المبيعة فقط، ولا تُخصم قيمة المخزون المتبقي.</p>}
    {data && <MoneyDistribution data={data} />}
    {data && costLines?.rows?.length > 0 && <section className="rounded-2xl border border-white/10 bg-card p-5">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2"><h2 className="text-gold">تكلفة البنود المبيعة</h2><button className={secondaryClass} onClick={() => setCostOpen(open => !open)}>{costOpen ? 'إخفاء التفصيل' : 'عرض التفصيل'}</button></div>
      <p className="text-xs text-neutral-500">مجموع تكلفة البنود: {formatDzd(costLines.totalCost)} · عدد البنود: {costLines.totalLines}. تُخصم هذه القيمة فقط من المبيعات، ولا تُخصم قيمة المخزون المتبقي.</p>
      {costOpen && <div className="mt-4 overflow-x-auto"><table className="w-full min-w-[720px] text-right text-sm"><thead><tr className="text-neutral-500">{['التاريخ', 'المنتج', 'المقاس', 'الكمية', 'تكلفة الوحدة', 'تكلفة البند', 'المصدر'].map(label => <th className="p-3 font-normal" key={label}>{label}</th>)}</tr></thead><tbody>{costLines.rows.map((row, index) => <tr key={index} className="border-t border-white/5 text-neutral-300"><td className="whitespace-nowrap p-3">{new Date(row.created_at).toLocaleDateString('ar-DZ')}</td><td className="p-3">{row.product}</td><td className="p-3">{row.variant}</td><td className="p-3">{row.quantity}</td><td className="p-3">{formatDzd(row.unitCost)}</td><td className="p-3">{formatDzd(row.lineCost)}</td><td className="whitespace-nowrap p-3 text-xs text-neutral-500">{{ snapshot: 'محفوظة وقت البيع', history: 'من فواتير الشراء', current: 'متوسط حالي' }[row.source] || row.source}</td></tr>)}</tbody></table></div>}
    </section>}
    <section className="rounded-2xl border border-white/10 bg-card p-5"><h2 className="mb-4 text-gold">دفتر اليومية</h2><div className="overflow-x-auto"><table className="w-full min-w-[620px] text-right text-sm"><thead><tr className="text-neutral-500">{['التاريخ', 'النوع', 'التفاصيل', 'المبلغ', 'الإيصال'].map(label => <th className="p-3 font-normal" key={label}>{label}</th>)}</tr></thead><tbody>{journal?.rows.map(row => <tr key={`${row.type}:${row.id}`} className="border-t border-white/5 text-neutral-300"><td className="whitespace-nowrap p-3">{new Date(row.created_at).toLocaleString('ar-DZ')}</td><td className="p-3">{TYPES[row.type]}</td><td className="max-w-md break-words p-3">{row.details}</td><td className={`whitespace-nowrap p-3 ${row.type === 'sale' ? 'text-gold' : 'text-neutral-400'}`}>{row.type === 'sale' ? '+' : '−'} {formatDzd(row.amount)}</td><td className="p-3">{row.receipt?.startsWith(`${ctx.tenantId}/`) ? <button className="text-gold underline" onClick={() => receipt(row.receipt)}>عرض</button> : '—'}</td></tr>)}{!loading && !journal?.rows.length && <tr><td colSpan={5} className="p-6 text-center text-neutral-500">لا توجد قيود للفترة المحددة.</td></tr>}</tbody></table></div><div className="mt-4 flex items-center justify-between"><button className={secondaryClass} disabled={loading || page === 0} onClick={() => setPage(p => p - 1)}>السابق</button><span className="text-xs text-neutral-500">صفحة {page + 1}</span><button className={secondaryClass} disabled={loading || !journal?.hasMore} onClick={() => setPage(p => p + 1)}>التالي</button></div></section>
    <p className="text-xs leading-6 text-neutral-500">صافي الربح = المبيعات − تكلفة البضاعة − المصاريف − الرواتب والسلف. تُحفظ تكلفة البنود الجديدة عند البيع؛ تُستعاد تكلفة المبيعات القديمة من فواتير الشراء السابقة للبيع{data ? ` (${data.estimatedCostItems} بند بلا تاريخ شراء)` : ''}. دفعات الموردين لا تخصم مرتين. المصاريف تشمل الحالات المسجلة، والأجور حسب تاريخ الدفع لا شهر الاستحقاق. لا يشمل هذا المؤشر الضرائب والمرتجعات أو تسوية السلف تلقائياً.</p>
    <EmployeePayments onSaved={refresh} />
  </div></>
}
