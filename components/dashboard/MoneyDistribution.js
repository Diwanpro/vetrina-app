'use client'
import { distribution } from '@/lib/commercial'
import { formatDzd } from '@/lib/app-context'
export default function MoneyDistribution({ data }) {
  const slices = distribution(data)
  const total = slices.reduce((sum, item) => sum + item.value, 0)
  let offset = 0
  return <section className="rounded-2xl border border-white/10 bg-card p-5"><h2 className="text-gold">توزيع الأموال</h2><div className="mt-4 flex flex-col items-center gap-6 sm:flex-row">
    {total > 0 ? <svg viewBox="0 0 42 42" role="img" aria-label="توزيع تكلفة البضاعة والمصاريف والرواتب والربح" className="h-56 w-56 shrink-0 -rotate-90"><circle cx="21" cy="21" r="15.9155" fill="none" stroke="#252525" strokeWidth="7" />{slices.map(item => { const size = item.value / total * 100; const start = offset; offset += size; return <circle key={item.label} cx="21" cy="21" r="15.9155" fill="none" stroke={item.color} strokeWidth="7" strokeDasharray={`${size} ${100 - size}`} strokeDashoffset={-start}><title>{item.label}: {formatDzd(item.value)}</title></circle> })}</svg> : <p className="p-8 text-sm text-neutral-500">لا توجد بيانات للرسم في هذه الفترة.</p>}
    <ul className="w-full space-y-3">{slices.map(item => <li key={item.label} className="flex items-center justify-between gap-3 text-sm"><span className="flex items-center gap-2 text-neutral-300"><span className="h-3 w-3 rounded-full" style={{ background: item.color }} />{item.label}</span><span className="text-neutral-200">{formatDzd(item.value)}</span></li>)}</ul>
  </div>{Number(data.netProfit) < 0 && <p className="text-sm text-red-300">خسارة: {formatDzd(-Number(data.netProfit))} · لا تُمثّل القيم السالبة كقطاعات في الرسم.</p>}
  </section>
}
