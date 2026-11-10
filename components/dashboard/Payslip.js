'use client'
import { useEffect, useState } from 'react'
import { Modal, Notice, secondaryClass } from './EngineUI'
import { useDashboardSession } from './SessionProvider'
import { supabase } from '@/lib/supabase'
import { formatDzd } from '@/lib/app-context'
import { SALARY_TYPES } from '@/lib/commercial'

export default function Payslip({ user, onClose }) {
  const ctx = useDashboardSession()
  const [data, setData] = useState(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [retry, setRetry] = useState(0)
  useEffect(() => {
    let live = true
    setData(null); setError(''); setLoading(true)
    supabase.rpc('engine_payslip', { p_user: user.id }).then(result => {
      if (result.error) throw result.error
      if (live) setData(result.data)
    }).catch(err => { if (live) setError(err.message) }).finally(() => { if (live) setLoading(false) })
    return () => { live = false }
  }, [user.id, retry])
  const rows = data ? [['الأجر الأساسي', data.base_salary], ['إجمالي مبيعات الموظف', data.total_sales], [`العمولة (${data.commission_percentage}%)`, data.commissions], ['السلف المستلمة', -Number(data.advances)]] : []
  return <Modal title="كشف الأجر" onClose={onClose} wide><Notice error={error} />
    {loading && <p role="status" className="py-8 text-center text-gold">جاري إعداد كشف الأجر...</p>}
    {error && <button className={secondaryClass} onClick={() => setRetry(v => v + 1)}>إعادة المحاولة</button>}
    {data && <article className="rounded-xl border border-gold/30 bg-[#131313] p-5 sm:p-7" dir="rtl">
      <header className="flex flex-wrap justify-between gap-4 border-b border-gold/30 pb-5"><div><p className="text-xs tracking-[0.3em] text-gold">VETRINA</p><h2 className="mt-2 text-xl text-neutral-100">{ctx.tenant.name}</h2><p className="mt-1 text-sm text-neutral-500">كشف الأجر · {new Date(`${data.month}T12:00:00`).toLocaleDateString('ar-DZ', { month: 'long', year: 'numeric' })}</p></div><span className="h-fit rounded-full border border-gold/30 px-3 py-1 text-xs text-gold">بيان استحقاق · للمراجعة</span></header>
      <div className="my-5 grid gap-3 text-sm sm:grid-cols-2"><p className="text-neutral-400">الموظف: <strong className="font-normal text-neutral-100">{data.employee.name}</strong></p><p className="text-neutral-400">نوع الأجر: <span className="text-neutral-100">{SALARY_TYPES[data.employee.salary_type] || 'غير محدد'}</span></p><p className="text-neutral-500">اسم المستخدم: {data.employee.username}</p><p className="text-neutral-500">المرجع: {data.employee.id.slice(0, 8)}</p></div>
      <dl className="divide-y divide-white/5">{rows.map(([label, value]) => <div key={label} className="flex flex-wrap justify-between gap-3 py-3 text-sm"><dt className="text-neutral-400">{label}</dt><dd className={Number(value) < 0 ? 'text-red-300' : 'text-neutral-200'}>{formatDzd(value)}</dd></div>)}</dl>
      <div className="mt-5 flex flex-wrap items-center justify-between gap-4 rounded-lg border border-gold/30 bg-gold/5 p-4"><h3 className="text-sm text-gold">صافي المبلغ المستحق</h3><p className={`text-2xl font-semibold ${Number(data.net_payable) < 0 ? 'text-red-300' : 'text-gold'}`}>{formatDzd(data.net_payable)}</p></div>
      <p className="mt-5 text-xs leading-6 text-neutral-500">الصافي = الأجر الأساسي + العمولة − السلف. المبيعات المكتملة والمتزامنة لهذا الموظف في جميع فروع المؤسسة، حسب شهر الجزائر الحالي. هذا الكشف لا يسجل دفعاً ولا يخصم الرواتب المدفوعة سابقاً.</p>
      {data.employee.salary_type === 'daily' && <p className="mt-2 text-xs leading-6 text-amber-300">للأجر اليومي: المعروض هو أجر اليوم الواحد وفق المعادلة المطلوبة، ولا يُضرب تلقائياً في أيام الحضور.</p>}
      <footer className="mt-6 flex justify-between border-t border-white/10 pt-4 text-xs text-neutral-500"><span>توقيع الإدارة: ــــــــــــــــــ</span><span>توقيع الموظف: ــــــــــــــــــ</span></footer>
    </article>}
  </Modal>
}
