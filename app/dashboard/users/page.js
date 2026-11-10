'use client'
import { useEffect, useState } from 'react'
import DashboardShell from '@/components/dashboard/DashboardShell'
import { useDashboardSession } from '@/components/dashboard/SessionProvider'
import { Notice, Modal, fieldClass, primaryClass, secondaryClass } from '@/components/dashboard/EngineUI'
import { supabase } from '@/lib/supabase'
import { formatDzd } from '@/lib/app-context'
import { SALARY_TYPES, validateHr } from '@/lib/commercial'

export default function UsersPage() {
  const ctx = useDashboardSession()
  const [employees, setEmployees] = useState([])
  const [form, setForm] = useState({ firstName: '', lastName: '', salaryType: 'fixed', salaryAmount: '', username: '', pin: '', role: 'employee', storeId: ctx.storeId || ctx.stores[0]?.id || '' })
  const [modal, setModal] = useState(false)
  const [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')
  const [version, setVersion] = useState(0)
  const change = event => setForm(previous => ({ ...previous, [event.target.name]: event.target.value }))
  useEffect(() => {
    let live = true
    setLoading(true); setEmployees([]); setError('')
    if (ctx.role !== 'owner') { setLoading(false); return }
    supabase.rpc('engine_employees', { p_store: ctx.storeId }).then(result => {
      if (result.error) throw result.error
      if (live) setEmployees(result.data || [])
    }).catch(err => { if (live) setError(err.message) }).finally(() => { if (live) setLoading(false) })
    return () => { live = false }
  }, [ctx.role, ctx.storeId, version])
  async function save(event) {
    event.preventDefault(); if (busy) return
    setBusy(true); setError(''); setSuccess('')
    try {
      if (ctx.role !== 'owner' || !navigator.onLine) throw new Error('يتطلب صلاحية المالك والاتصال بالإنترنت')
      validateHr(form)
      const { data, error } = await supabase.functions.invoke('create-employee', { body: { ...form, username: form.username.trim().toLowerCase(), salaryAmount: Number(form.salaryAmount) } })
      if (error) {
        let message = 'تعذر إنشاء الموظف. حدّث القائمة قبل إعادة المحاولة.'
        try { message = (await error.context.json()).error || message } catch {}
        throw new Error(message)
      }
      if (data?.error) throw new Error(data.error)
      setForm(previous => ({ ...previous, firstName: '', lastName: '', username: '', pin: '', salaryAmount: '' })); setModal(false)
      setSuccess('تم إنشاء حساب الموظف وملفه الوظيفي'); setVersion(v => v + 1)
    } catch (err) { setError(err.message) } finally { setBusy(false) }
  }
  return <DashboardShell active="/dashboard/users"><div className="mx-auto max-w-5xl space-y-5">
    <header className="flex flex-wrap items-center justify-between gap-3"><div><h1 className="text-xl text-gold">إدارة الموظفين</h1><p className="mt-2 text-xs text-neutral-500">الموارد البشرية · بيانات الأجور والحسابات</p></div><button className={primaryClass} onClick={() => { setError(''); setModal(true) }}>إضافة موظف</button></header>
    <Notice error={error} success={success} />
    <section className="rounded-2xl border border-white/10 bg-card p-5"><div className="mb-4 flex justify-between"><h2 className="text-gold">الموظفون · {ctx.allBranches ? 'جميع الفروع' : ctx.stores.find(s => s.id === ctx.storeId)?.name}</h2><button disabled={loading || busy} className={secondaryClass} onClick={() => setVersion(v => v + 1)}>تحديث</button></div>
      {loading ? <p className="text-neutral-400">جاري التحميل...</p> : !employees.length ? <p className="text-neutral-400">لا يوجد موظفون في النطاق المختار.</p> : <div className="overflow-x-auto"><table className="w-full min-w-[640px] text-right text-sm"><thead className="text-neutral-500"><tr>{['الاسم', 'اسم المستخدم', 'الفرع / الدور', 'نوع الأجر', 'المبلغ'].map(label => <th key={label} className="p-3 font-normal">{label}</th>)}</tr></thead><tbody>{employees.map(user => <tr key={user.id} className="border-t border-white/5 text-neutral-300"><td className="p-3">{[user.first_name, user.last_name].filter(Boolean).join(' ') || user.full_name || 'غير مسجل'}</td><td className="p-3">{user.username}{user.is_active === false && <span className="block text-red-300">غير نشط</span>}</td><td className="p-3">{ctx.stores.find(s => s.id === user.store_id)?.name || 'دون فرع'} · {user.role === 'manager' ? 'مدير' : 'موظف'}</td><td className="p-3">{SALARY_TYPES[user.salary_type] || 'غير محدد'}</td><td className="p-3 text-gold">{user.salary_type ? formatDzd(user.salary_amount) : '—'}</td></tr>)}</tbody></table></div>}
    </section>
    <p className="text-xs text-neutral-500">مبلغ العمولة قيمة نقدية متفق عليها وليس نسبة مئوية. صرف الرواتب والسلف متاح من شاشة المحاسبة.</p>
    {modal && <Modal title="إضافة موظف" busy={busy} onClose={() => { setModal(false); setForm(previous => ({ ...previous, pin: '' })) }} wide><Notice error={error} /><form onSubmit={save}><fieldset disabled={busy} className="grid gap-4 sm:grid-cols-2">
      {[['firstName', 'الاسم', 'text'], ['lastName', 'اللقب', 'text'], ['username', 'اسم المستخدم (لاتيني)', 'text'], ['pin', 'PIN (6–12 رقماً)', 'password']].map(([name, label, type]) => <label key={name} className="text-sm text-neutral-300">{label}<input required name={name} type={type} maxLength={name === 'username' ? 40 : name === 'pin' ? 12 : 100} pattern={name === 'username' ? '[a-zA-Z0-9_]{3,40}' : name === 'pin' ? '[0-9]{6,12}' : undefined} inputMode={name === 'pin' ? 'numeric' : undefined} autoComplete={name === 'pin' ? 'new-password' : 'off'} value={form[name]} onChange={change} className={`${fieldClass} mt-2`} /></label>)}
      <label className="text-sm text-neutral-300">نوع الأجر<select name="salaryType" value={form.salaryType} onChange={change} className={`${fieldClass} mt-2`}>{Object.entries(SALARY_TYPES).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
      <label className="text-sm text-neutral-300">المبلغ (دج)<input required type="number" name="salaryAmount" min="0" max="2147483647" step="1" value={form.salaryAmount} onChange={change} className={`${fieldClass} mt-2`} /></label>
      <label className="text-sm text-neutral-300">الدور<select name="role" value={form.role} onChange={change} className={`${fieldClass} mt-2`}><option value="employee">موظف</option><option value="manager">مدير</option></select></label>
      <label className="text-sm text-neutral-300">الفرع<select required name="storeId" value={form.storeId} onChange={change} className={`${fieldClass} mt-2`}>{ctx.stores.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
      <button className={primaryClass}>{busy ? 'جاري الحفظ...' : 'إنشاء الموظف'}</button>
    </fieldset></form></Modal>}
  </div></DashboardShell>
}
