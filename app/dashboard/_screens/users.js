'use client'
import { useEffect, useState } from 'react'
import { useDashboardSession } from '@/components/dashboard/SessionProvider'
import { Notice, Modal, fieldClass, primaryClass, secondaryClass } from '@/components/dashboard/EngineUI'
import CustomSelect from '@/components/ui/CustomSelect'
import { supabase } from '@/lib/supabase'
import { formatDzd } from '@/lib/app-context'
import Payslip from '@/components/dashboard/Payslip'
import { SALARY_TYPES, validateHr, salaryFields, salaryPayload } from '@/lib/commercial'

export default function UsersPage() {
  const ctx = useDashboardSession()
  const [employees, setEmployees] = useState([])
  const [form, setForm] = useState({ firstName: '', lastName: '', salaryType: 'fixed', salaryAmount: '', commissionPercentage: '', username: '', pin: '', role: 'employee', storeId: ctx.storeId || ctx.stores[0]?.id || '' })
  const [payslip, setPayslip] = useState(null)
  const fields = salaryFields(form.salaryType)
  const [modal, setModal] = useState(false)
  const [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')
  const [version, setVersion] = useState(0)
  const [confirmToggle, setConfirmToggle] = useState(null)
  const change = event => { const { name, value } = event.target; setForm(previous => name === 'salaryType' ? { ...previous, salaryType: value, salaryAmount: '', commissionPercentage: '' } : { ...previous, [name]: value }) }
  useEffect(() => {
    let live = true
    setLoading(true); setEmployees([]); setError('')
    if (ctx.role !== 'owner') { setLoading(false); return }
    supabase.rpc('engine_hr_overview', { p_store: ctx.storeId }).then(result => {
      if (result.error) throw result.error
      if (live) setEmployees(result.data || [])
    }).catch(err => { if (live) setError(err.message) }).finally(() => { if (live) setLoading(false) })
    return () => { live = false }
  }, [ctx.role, ctx.storeId, version])
  // Never delete an employee: sales, shifts and payroll reference the row.
  // Deactivating also bans the auth account so the PIN stops working at once.
  async function setActive(user, active) {
    setBusy(true); setError(''); setSuccess('')
    try {
      const { data, error } = await supabase.rpc('engine_set_employee_active', { p_user: user.id, p_active: active })
      if (error) throw error
      if (!data?.ok) throw new Error(data?.error || 'تعذر تحديث حالة الموظف')
      setConfirmToggle(null)
      setSuccess(active ? 'تم تفعيل الموظف' : 'تم إيقاف الموظف ومنع دخوله')
      setVersion(v => v + 1)
    } catch (err) { setError(err.message) } finally { setBusy(false) }
  }
  async function save(event) {
    event.preventDefault(); if (busy) return
    setBusy(true); setError(''); setSuccess('')
    try {
      if (ctx.role !== 'owner' || !navigator.onLine) throw new Error('يتطلب صلاحية المالك والاتصال بالإنترنت')
      validateHr(form)
      const { data, error } = await supabase.functions.invoke('create-employee', { body: { ...form, username: form.username.trim().toLowerCase(), ...salaryPayload(form) } })
      if (error) {
        let message = 'تعذر إنشاء الموظف. حدّث القائمة قبل إعادة المحاولة.'
        try { message = (await error.context.json()).error || message } catch {}
        throw new Error(message)
      }
      if (data?.error) throw new Error(data.error)
      setForm(previous => ({ ...previous, firstName: '', lastName: '', username: '', pin: '', salaryAmount: '', commissionPercentage: '' })); setModal(false)
      setSuccess('تم إنشاء حساب الموظف وملفه الوظيفي'); setVersion(v => v + 1)
    } catch (err) { setError(err.message) } finally { setBusy(false) }
  }
  return (
    <>
      <div className="mx-auto max-w-5xl space-y-5">
        <header className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-xl text-gold">إدارة الموظفين</h1>
            <p className="mt-2 text-xs text-neutral-500">الموارد البشرية · بيانات الأجور والحسابات</p>
          </div>
          <button className={primaryClass} onClick={() => { setError(''); setModal(true) }}>إضافة موظف</button>
        </header>
        <Notice error={error} success={success} />
        <section className="rounded-2xl border border-white/10 bg-card p-5">
          <div className="mb-4 flex justify-between">
            <h2 className="text-gold">الموظفون · {ctx.allBranches ? 'جميع الفروع' : ctx.stores.find(s => s.id === ctx.storeId)?.name}</h2>
            <button disabled={loading || busy} className={secondaryClass} onClick={() => setVersion(v => v + 1)}>تحديث</button>
          </div>
          {loading ? (
            <p className="text-neutral-400">جاري التحميل...</p>
          ) : !employees.length ? (
            <p className="text-neutral-400">لا يوجد موظفون في النطاق المختار.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[640px] text-right text-sm">
                <thead className="text-neutral-500">
                  <tr>
                    {['الاسم', 'اسم المستخدم', 'الفرع / الدور', 'نوع الأجر', 'الأجر / العمولة', 'حضور الشهر', 'كشف الأجر'].map(label => (
                      <th key={label} className="p-3 font-normal">{label}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {employees.map(user => (
                    <tr key={user.id} className="border-t border-white/5 text-neutral-300">
                      <td className="p-3">{[user.first_name, user.last_name].filter(Boolean).join(' ') || user.full_name || 'غير مسجل'}</td>
                      <td className="p-3">{user.username}{user.is_active === false && <span className="block text-red-300">غير نشط</span>}</td>
                      <td className="p-3">{ctx.stores.find(s => s.id === user.store_id)?.name || 'دون فرع'} · {user.role === 'manager' ? 'مدير' : 'موظف'}</td>
                      <td className="p-3">{SALARY_TYPES[user.salary_type] || 'غير محدد'}</td>
                      <td className="p-3 text-gold">
                        {salaryFields(user.salary_type).amount && <span className="block">{formatDzd(user.salary_amount)}</span>}
                        {salaryFields(user.salary_type).commission && <span className="block">{Number(user.commission_percentage || 0)}%</span>}
                        {!user.salary_type && '—'}
                      </td>
                      <td className="p-3">{user.attendance_days ?? 0} يوم</td>
                      <td className="p-3">
                        <div className="flex flex-wrap gap-2">
                          <button className={secondaryClass} onClick={() => setPayslip(user)}>كشف الأجر</button>
                          {user.is_active === false ? (
                            <button disabled={busy} className={secondaryClass} onClick={() => setConfirmToggle({ user, active: true })}>تفعيل</button>
                          ) : (
                            <button disabled={busy} className="rounded-lg border border-red-800/50 px-3 py-2 text-sm text-red-300 disabled:opacity-50" onClick={() => setConfirmToggle({ user, active: false })}>إيقاف الموظف</button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
        <p className="text-xs text-neutral-500">العمولة نسبة من مبيعات الموظف المتزامنة. الحضور حسب توقيت الجزائر. صرف الرواتب والسلف متاح من شاشة المحاسبة.</p>
        {modal && (
          <Modal title="إضافة موظف" busy={busy} onClose={() => { setModal(false); setForm(previous => ({ ...previous, pin: '' })) }} wide>
            <Notice error={error} />
            <form onSubmit={save}>
              <fieldset disabled={busy} className="grid gap-4 sm:grid-cols-2">
                {[['firstName', 'الاسم', 'text'], ['lastName', 'اللقب', 'text'], ['username', 'اسم المستخدم (لاتيني)', 'text'], ['pin', 'PIN (6–12 رقماً)', 'password']].map(([name, label, type]) => (
                  <label key={name} className="text-sm text-neutral-300">
                    {label}
                    <input required name={name} type={type} maxLength={name === 'username' ? 40 : name === 'pin' ? 12 : 100} pattern={name === 'username' ? '[a-zA-Z0-9_]{3,40}' : name === 'pin' ? '[0-9]{6,12}' : undefined} inputMode={name === 'pin' ? 'numeric' : undefined} autoComplete={name === 'pin' ? 'new-password' : 'off'} value={form[name]} onChange={change} className={`${fieldClass} mt-2`} />
                  </label>
                ))}
                <label className="text-sm text-neutral-300">نوع الأجر
                  <CustomSelect name="salaryType" value={form.salaryType} onChange={e => change({ target: { name: 'salaryType', value: e } })} options={Object.entries(SALARY_TYPES).map(([value, label]) => ({ label, value }))} className={`${fieldClass} mt-2`} />
                </label>
                {fields.amount && (
                  <label className="text-sm text-neutral-300">
                    {form.salaryType === 'daily' ? 'أجر اليوم الواحد' : 'المبلغ'} (دج)
                    <input required type="number" name="salaryAmount" min="0" max="2147483647" step="1" value={form.salaryAmount} onChange={change} className={`${fieldClass} mt-2`} />
                  </label>
                )}
                {fields.commission && (
                  <label className="text-sm text-neutral-300">
                    نسبة العمولة (%)
                    <input required type="number" name="commissionPercentage" min="0" max="100" step="0.01" value={form.commissionPercentage} onChange={change} className={`${fieldClass} mt-2`} />
                  </label>
                )}
                <label className="text-sm text-neutral-300">الدور
                  <CustomSelect name="role" value={form.role} onChange={e => change({ target: { name: 'role', value: e } })} options={[{ label: 'مدير', value: 'manager' }, { label: 'موظف', value: 'employee' }]} className={`${fieldClass} mt-2`} />
                </label>
                <label className="text-sm text-neutral-300">الفرع
                  <CustomSelect required name="storeId" value={form.storeId} onChange={e => change({ target: { name: 'storeId', value: e } })} options={ctx.stores.map(s => ({ label: s.name, value: s.id }))} className={`${fieldClass} mt-2`} />
                </label>
                <button className={primaryClass}>{busy ? 'جاري الحفظ...' : 'إنشاء الموظف'}</button>
              </fieldset>
            </form>
          </Modal>
        )}
        {payslip && <Payslip user={payslip} onClose={() => setPayslip(null)} />}
        {confirmToggle && (
          <Modal title={confirmToggle.active ? 'تفعيل الموظف' : 'إيقاف الموظف'} onClose={() => setConfirmToggle(null)} busy={busy}>
            <p className="mb-3 text-sm text-neutral-300">{[confirmToggle.user.first_name, confirmToggle.user.last_name].filter(Boolean).join(' ') || confirmToggle.user.username}</p>
            <p className="mb-4 rounded-lg border border-amber-700/30 bg-amber-950/20 p-3 text-xs text-amber-200">
              {confirmToggle.active
                ? 'سيستطيع الموظف الدخول مجدداً بنفس رمز الدخول.'
                : 'لن يستطيع الموظف الدخول بعد الآن. لا يُحذف السجل، وتبقى مبيعاته ورواتبه وحضوره في التقارير.'}
            </p>
            <div className="flex gap-3">
              <button disabled={busy} className={confirmToggle.active ? primaryClass : 'rounded-lg bg-red-900/60 px-4 py-2 text-sm text-red-100'} onClick={() => setActive(confirmToggle.user, confirmToggle.active)}>
                {confirmToggle.active ? 'تفعيل' : 'إيقاف الموظف'}
              </button>
              <button disabled={busy} className={secondaryClass} onClick={() => setConfirmToggle(null)}>إلغاء</button>
            </div>
          </Modal>
        )}
      </div>
    </>
  )
}
