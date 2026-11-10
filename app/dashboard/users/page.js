'use client'
import { useEffect, useRef, useState } from 'react'
import DashboardShell from '@/components/dashboard/DashboardShell'
import { useDashboardSession } from '@/components/dashboard/SessionProvider'
import { Notice, Modal, fieldClass, primaryClass, secondaryClass } from '@/components/dashboard/EngineUI'
import { supabase } from '@/lib/supabase'
import { validMoney } from '@/lib/cash'

export default function UsersPage() {
  const ctx = useDashboardSession()
  const [employees, setEmployees] = useState([])
  const [username, setUsername] = useState('')
  const [pin, setPin] = useState('')
  const [role, setRole] = useState('employee')
  const [store, setStore] = useState(ctx.storeId || ctx.stores[0]?.id || '')
  const [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')
  const [version, setVersion] = useState(0)
  const [payment, setPayment] = useState(null)
  const [amount, setAmount] = useState('')
  const [detail, setDetail] = useState('')
  const request = useRef(null)
  useEffect(() => {
    let live = true
    setLoading(true); setEmployees([])
    if (ctx.role !== 'owner') { setLoading(false); return }
    supabase.rpc('engine_employees', { p_store: ctx.storeId }).then(result => {
      if (result.error) throw result.error
      if (live) setEmployees(result.data || [])
    }).catch(err => { if (live) setError(err.message) }).finally(() => { if (live) setLoading(false) })
    return () => { live = false }
  }, [ctx.role, ctx.storeId, version])
  async function addEmployee(event) {
    event.preventDefault(); if (busy) return
    setBusy(true); setError(''); setSuccess('')
    try {
      if (ctx.role !== 'owner' || !navigator.onLine) throw new Error('يتطلب صلاحية المالك والاتصال بالإنترنت')
      const { data, error } = await supabase.functions.invoke('create-employee', { body: { username: username.trim().toLowerCase(), pin, role, storeId: store } })
      if (error || data?.error) throw new Error(data?.error || 'تعذر إضافة الموظف. تأكد أن الاسم غير مستخدم وأن PIN يطابق السياسة، ثم حدّث القائمة قبل إعادة المحاولة.')
      setUsername(''); setPin(''); setSuccess('تم إنشاء حساب الموظف ويمكنه الدخول باسم المستخدم وPIN'); setVersion(v => v + 1)
    } catch (err) { setError(err.message) } finally { setBusy(false) }
  }
  async function savePayment(event) {
    event.preventDefault(); if (busy) return
    setBusy(true); setError(''); setSuccess('')
    try {
      if (!navigator.onLine || ctx.role !== 'owner') throw new Error('يتطلب الاتصال وصلاحية المالك')
      if (!validMoney(amount) || Number(amount) <= 0 || Number(amount) > 2147483647 || !detail.trim()) throw new Error('أدخل مبلغاً صحيحاً موجباً والتفاصيل')
      const key = JSON.stringify([payment.user.id, payment.kind, amount, detail.trim()])
      if (request.current?.key !== key) request.current = { key, id: crypto.randomUUID() }
      const { error } = await supabase.rpc('engine_employee_payment', { p_user: payment.user.id, p_kind: payment.kind, p_amount: Number(amount), p_detail: detail.trim(), p_request: request.current.id })
      if (error) throw error
      request.current = null; setPayment(null); setSuccess('تم تسجيل الدفع وخصمه من النقد المتوقع لصندوق فرع الموظف')
    } catch (err) { setError(err.message) } finally { setBusy(false) }
  }
  return <DashboardShell active="/dashboard/users"><div className="mx-auto max-w-5xl space-y-5">
    <h1 className="text-xl text-gold">إدارة الموظفين والرواتب</h1><Notice error={error} success={success} />
    <form onSubmit={addEmployee} className="rounded-2xl border border-gold/20 bg-card p-5"><h2 className="mb-4 text-gold">إضافة موظف</h2><fieldset disabled={busy} className="grid gap-4 sm:grid-cols-2">
      <label className="text-sm text-neutral-300">اسم المستخدم<input required pattern="[a-zA-Z0-9_]{3,40}" autoComplete="off" value={username} onChange={e => setUsername(e.target.value)} className={`${fieldClass} mt-2`} /><span className="text-xs text-neutral-500">3–40 حرفاً لاتينياً أو رقماً أو _، فريد في التطبيق</span></label>
      <label className="text-sm text-neutral-300">PIN<input required type="password" inputMode="numeric" pattern="[0-9]{6,12}" autoComplete="new-password" value={pin} onChange={e => setPin(e.target.value)} className={`${fieldClass} mt-2`} /><span className="text-xs text-neutral-500">6–12 رقماً</span></label>
      <label className="text-sm text-neutral-300">الدور<select value={role} onChange={e => setRole(e.target.value)} className={`${fieldClass} mt-2`}><option value="employee">موظف</option><option value="manager">مدير</option></select></label>
      <label className="text-sm text-neutral-300">الفرع<select required value={store} onChange={e => setStore(e.target.value)} className={`${fieldClass} mt-2`}>{ctx.stores.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
      <button className={primaryClass}>{busy ? 'جاري الحفظ...' : 'إضافة موظف'}</button>
    </fieldset></form>
    <section className="rounded-2xl border border-white/10 bg-card p-5"><div className="mb-4 flex justify-between"><h2 className="text-gold">الموظفون · {ctx.allBranches ? 'جميع الفروع' : ctx.stores.find(s => s.id === ctx.storeId)?.name}</h2><button disabled={busy || loading} className={secondaryClass} onClick={() => setVersion(v => v + 1)}>تحديث</button></div>
      {loading ? <p className="text-neutral-400">جاري التحميل...</p> : !employees.length ? <p className="text-neutral-400">لا يوجد موظفون في النطاق المختار.</p> : <div className="space-y-3">{employees.map(user => <div key={user.id} className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-white/10 p-4"><div className="text-neutral-200">{user.username}<p className="text-xs text-neutral-500">{user.role === 'manager' ? 'مدير' : 'موظف'} · {ctx.stores.find(s => s.id === user.store_id)?.name || 'دون فرع'} · {user.is_active === false ? 'غير نشط' : 'نشط'}</p></div><div className="flex gap-2">{[['advance', 'تسجيل سلفة'], ['payroll', 'تسجيل راتب']].map(([kind, label]) => <button key={kind} disabled={busy || !user.store_id} className={secondaryClass} onClick={() => { setPayment({ user, kind }); setAmount(''); setDetail(''); setError('') }}>{label}</button>)}</div></div>)}</div>}
    </section>
    <p className="text-xs text-neutral-500">الدفع نقدي من صندوق فرع الموظف ويتطلب وردية مفتوحة. الرواتب والسلف سجلات منفصلة؛ السلفة لا تخصم تلقائياً من راتب لاحق.</p>
    {payment && <Modal title={`${payment.kind === 'advance' ? 'تسجيل سلفة' : 'تسجيل راتب'} · ${payment.user.username}`} busy={busy} onClose={() => setPayment(null)}><Notice error={error} /><form onSubmit={savePayment} className="space-y-4"><fieldset disabled={busy} className="space-y-4"><label className="block text-sm">المبلغ (دج)<input required type="number" min="1" max="2147483647" step="1" value={amount} onChange={e => setAmount(e.target.value)} className={`${fieldClass} mt-2`} /></label><label className="block text-sm">{payment.kind === 'advance' ? 'السبب' : 'شهر الاستحقاق'}<input required type={payment.kind === 'advance' ? 'text' : 'month'} maxLength={500} value={detail} onChange={e => setDetail(e.target.value)} className={`${fieldClass} mt-2`} /></label><button className={primaryClass}>{busy ? 'جاري الدفع...' : 'تأكيد الدفع النقدي'}</button></fieldset></form></Modal>}
  </div></DashboardShell>
}
