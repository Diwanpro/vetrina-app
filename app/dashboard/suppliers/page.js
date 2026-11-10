'use client'

import { useEffect, useRef, useState } from 'react'
import DashboardShell from '@/components/dashboard/DashboardShell'
import { Modal, Notice, fieldClass, primaryClass, secondaryClass } from '@/components/dashboard/EngineUI'
import { supabase } from '@/lib/supabase'
import { getAppContext, formatDzd } from '@/lib/app-context'
import { fetchAllRows, validMoney } from '@/lib/cash'

export default function SuppliersPage() {
  const [suppliers, setSuppliers] = useState([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [modal, setModal] = useState(null)
  const [form, setForm] = useState({ name: '', phone: '', supplied_goods: '' })
  const [amount, setAmount] = useState('')
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')
  const paymentRequest = useRef(null)
  const saving = useRef(false)

  async function load() {
    setLoading(true)
    try {
      const ctx = await getAppContext()
      if (!ctx.storeId || !ctx.tenantId) throw new Error('تعذر تحديد المتجر أو المؤسسة')
      const rows = await fetchAllRows(supabase.from('suppliers').select('id, name, phone, total_debt, supplied_goods')
        .eq('tenant_id', ctx.tenantId).eq('store_id', ctx.storeId).order('name').order('id'))
      setSuppliers(rows)
    } catch (err) { setError(err.message) }
    finally { setLoading(false) }
  }
  useEffect(() => { load() }, [])

  function openAdd() {
    setError(''); setSuccess(''); setForm({ name: '', phone: '', supplied_goods: '' }); setModal({ type: 'add' })
  }
  function openPayment(supplier) {
    setError(''); setSuccess(''); setAmount(''); paymentRequest.current = null
    setModal({ type: 'payment', supplier })
  }
  async function save(event) {
    event.preventDefault()
    if (saving.current) return
    saving.current = true; setBusy(true); setError(''); setSuccess('')
    try {
      const ctx = await getAppContext()
      if (!ctx.tenantId || !ctx.storeId) throw new Error('تعذر تحديد المتجر')
      if (modal.type === 'add') {
        if (!form.name.trim()) throw new Error('اسم المورد مطلوب')
        const { error } = await supabase.rpc('engine_add_supplier', {
          p_store: ctx.storeId, p_tenant: ctx.tenantId, p_name: form.name.trim(),
          p_phone: form.phone.trim(), p_goods: form.supplied_goods.trim(),
        })
        if (error) throw error
        setSuccess('تمت إضافة المورد')
      } else {
        if (!validMoney(amount) || Number(amount) <= 0 || Number(amount) > Number(modal.supplier.total_debt)) throw new Error('أدخل دفعة موجبة لا تتجاوز الدين المتبقي')
        const key = `${modal.supplier.id}:${amount}`
        if (paymentRequest.current?.key !== key) paymentRequest.current = { key, id: crypto.randomUUID() }
        const { error } = await supabase.rpc('engine_pay_supplier', {
          p_store: ctx.storeId, p_tenant: ctx.tenantId, p_supplier: modal.supplier.id,
          p_amount: Number(amount), p_request: paymentRequest.current.id,
        })
        if (error) throw error
        setSuccess('تم تسجيل الدفعة وتحديث الدين')
      }
      setModal(null)
      await load()
    } catch (err) { setError(err.message || 'تعذر الحفظ') }
    finally { saving.current = false; setBusy(false) }
  }

  return <DashboardShell active="/dashboard/suppliers">
    <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
      <div><h1 className="text-lg text-neutral-100">الموردون</h1><p className="mt-1 text-xs text-neutral-500">الموردون والمديونية الخاصة بالمتجر الحالي</p></div>
      <div className="flex gap-2"><a href="/dashboard/purchases" className={secondaryClass}>فاتورة شراء</a><button onClick={openAdd} className={primaryClass}>إضافة مورد</button></div>
    </div>
    {!modal && <Notice error={error} success={success} />}
    {loading ? <p className="text-sm text-neutral-400">جاري التحميل...</p> : <>
      <p className="mb-4 text-sm text-gold">إجمالي الدين: {formatDzd(suppliers.reduce((sum, row) => sum + Number(row.total_debt || 0), 0))}</p>
      {!suppliers.length ? <p className="rounded-xl border border-dashed border-white/10 p-8 text-center text-neutral-500">لا يوجد موردون في هذا المتجر بعد.</p> :
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">{suppliers.map(supplier => <article key={supplier.id} className="rounded-xl border border-white/10 bg-card p-4">
          <h2 className="mb-2 font-medium text-neutral-100">{supplier.name}</h2>
          <p className="mb-2 text-sm text-neutral-400">الهاتف: <span dir="ltr">{supplier.phone || '—'}</span></p>
          <p className="mb-3 whitespace-pre-wrap text-sm text-neutral-400">السلع الموردة: {supplier.supplied_goods || '—'}</p>
          <p className="mb-4 text-gold">الدين المتبقي: {formatDzd(supplier.total_debt)}</p>
          <button disabled={Number(supplier.total_debt || 0) <= 0} onClick={() => openPayment(supplier)} className={secondaryClass}>تسجيل دفعة</button>
        </article>)}</div>}
      <button onClick={() => { setError(''); load() }} className={`${secondaryClass} mt-4`}>تحديث</button>
    </>}
    {modal && <Modal title={modal.type === 'add' ? 'إضافة مورد' : `تسجيل دفعة · ${modal.supplier.name}`} busy={busy} onClose={() => { setModal(null); setError('') }}>
      <form onSubmit={save} className="space-y-4">
        <Notice error={error} />
        {modal.type === 'add' ? <>
          <label className="block text-sm">اسم المورد<input autoFocus required disabled={busy} maxLength={200} value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} className={`${fieldClass} mt-1`} /></label>
          <label className="block text-sm">الهاتف<input type="tel" disabled={busy} maxLength={50} value={form.phone} onChange={e => setForm({ ...form, phone: e.target.value })} className={`${fieldClass} mt-1`} /></label>
          <label className="block text-sm">السلع الموردة<textarea disabled={busy} maxLength={2000} value={form.supplied_goods} onChange={e => setForm({ ...form, supplied_goods: e.target.value })} className={`${fieldClass} mt-1`} /></label>
        </> : <>
          <p className="text-sm text-gold">الدين المتبقي: {formatDzd(modal.supplier.total_debt)}</p>
          <label className="block text-sm">مبلغ الدفعة (دج)<input autoFocus required type="number" min="1" max={modal.supplier.total_debt} step="1" disabled={busy} value={amount} onChange={e => setAmount(e.target.value)} className={`${fieldClass} mt-1`} /></label>
        </>}
        <button disabled={busy} className={`${primaryClass} w-full`}>{busy ? 'جاري الحفظ...' : 'حفظ'}</button>
      </form>
    </Modal>}
  </DashboardShell>
}
