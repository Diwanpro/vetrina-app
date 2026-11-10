'use client'
import { useEffect, useRef, useState } from 'react'
import { useDashboardSession } from './SessionProvider'
import { Notice, Modal, fieldClass, primaryClass, secondaryClass } from './EngineUI'
import { supabase } from '@/lib/supabase'
import { validMoney } from '@/lib/cash'
export default function EmployeePayments({ onSaved }) {
  const ctx = useDashboardSession()
  const [employees, setEmployees] = useState([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')
  const [payment, setPayment] = useState(null)
  const [amount, setAmount] = useState('')
  const [detail, setDetail] = useState('')
  const request = useRef(null)
  useEffect(() => {
    let live = true
    supabase.rpc('engine_employees', { p_store: ctx.storeId }).then(({ data, error }) => { if (error) throw error; if (live) setEmployees(data || []) }).catch(err => { if (live) setError(err.message) })
    return () => { live = false }
  }, [ctx.storeId])
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
      request.current = null; setPayment(null); onSaved?.(); setSuccess('تم تسجيل الدفع وخصمه من النقد المتوقع لصندوق فرع الموظف')
    } catch (err) { setError(err.message) } finally { setBusy(false) }
  }
  return <section className="rounded-2xl border border-white/10 bg-card p-5"><h2 className="mb-3 text-gold">دفع الرواتب والسلف</h2><Notice error={error} success={success} />
    <div className="flex flex-wrap gap-3">{employees.map(user => <div key={user.id} className="rounded-xl border border-white/10 p-3"><p className="mb-2 text-sm text-neutral-300">{user.full_name || user.username}</p><div className="flex gap-2">{[['advance', 'تسجيل سلفة'], ['payroll', 'تسجيل راتب']].map(([kind, label]) => <button key={kind} disabled={busy || !user.store_id} className={secondaryClass} onClick={() => { setPayment({ user, kind }); setAmount(''); setDetail(''); setError('') }}>{label}</button>)}</div></div>)}</div>
    {payment && <Modal title={`${payment.kind === 'advance' ? 'تسجيل سلفة' : 'تسجيل راتب'} · ${payment.user.username}`} busy={busy} onClose={() => setPayment(null)}><Notice error={error} /><form onSubmit={savePayment} className="space-y-4"><fieldset disabled={busy} className="space-y-4"><label className="block text-sm">المبلغ (دج)<input required type="number" min="1" max="2147483647" step="1" value={amount} onChange={e => setAmount(e.target.value)} className={`${fieldClass} mt-2`} /></label><label className="block text-sm">{payment.kind === 'advance' ? 'السبب' : 'شهر الاستحقاق'}<input required type={payment.kind === 'advance' ? 'text' : 'month'} maxLength={500} value={detail} onChange={e => setDetail(e.target.value)} className={`${fieldClass} mt-2`} /></label><button className={primaryClass}>{busy ? 'جاري الدفع...' : 'تأكيد الدفع النقدي'}</button></fieldset></form></Modal>}
  </section>
}
