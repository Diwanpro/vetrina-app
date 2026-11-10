'use client'
import { useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useDashboardSession } from './SessionProvider'
import { Notice, Modal, fieldClass, primaryClass, secondaryClass } from './EngineUI'
import { supabase } from '@/lib/supabase'
import { validMoney } from '@/lib/cash'
import { RECEIPT_TYPES, validateReceipt } from '@/lib/commercial'

export default function ExpenseButton() {
  const ctx = useDashboardSession()
  const [open, setOpen] = useState(false)
  const [store, setStore] = useState(ctx.storeId || ctx.stores[0]?.id || '')
  const [amount, setAmount] = useState('')
  const [description, setDescription] = useState('')
  const [file, setFile] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')
  const request = useRef(null)
  async function save(event) {
    event.preventDefault(); if (busy) return
    setBusy(true); setError('')
    try {
      if (!navigator.onLine) throw new Error('تسجيل المصاريف يتطلب الاتصال بالإنترنت')
      if (!ctx.stores.some(s => s.id === store) || (ctx.role !== 'owner' && store !== ctx.assignedStoreId)) throw new Error('فرع غير صالح')
      if (!validMoney(amount) || Number(amount) <= 0 || Number(amount) > 2147483647 || !description.trim()) throw new Error('أدخل مبلغاً صحيحاً موجباً ووصفاً')
      validateReceipt(file)
      const key = JSON.stringify([store, amount, description.trim()])
      if (request.current?.key !== key || request.current?.file !== file) request.current = { key, file, id: crypto.randomUUID(), path: null, uploaded: false }
      const current = request.current
      if (file && !current.uploaded) {
        current.path ||= `${ctx.tenantId}/${store}/${ctx.user.id}/${current.id}.${RECEIPT_TYPES[file.type]}`
        const { error } = await supabase.storage.from('expense-receipts').upload(current.path, file, { contentType: file.type, upsert: false })
        // A lost upload response may leave the object in place. Retry never overwrites it.
        if (error && String(error.statusCode) !== '409') throw error
        current.uploaded = true
      }
      const { error } = await supabase.rpc('engine_record_expense_for_staff', { p_staff: ctx.staffId, p_store: store, p_amount: Number(amount), p_description: description.trim(), p_receipt: current.path, p_request: current.id })
      if (error) throw error
      request.current = null; setAmount(''); setDescription(''); setFile(null); setOpen(false); setSuccess('تم تسجيل المصروف')
      window.dispatchEvent(new Event('vetrina:finance'))
    } catch (err) { setError(err.message || 'تعذر الحفظ؛ أعد المحاولة بنفس البيانات لتجنب التكرار') } finally { setBusy(false) }
  }
  return <><button type="button" className={secondaryClass} onClick={() => { setSuccess(''); setOpen(true) }}>تسجيل مصروف</button>{success && <span role="status" className="text-xs text-emerald-300">{success}</span>}
    {open && createPortal(<Modal title="تسجيل مصروف" busy={busy} onClose={() => setOpen(false)}><Notice error={error} /><form onSubmit={save}><fieldset disabled={busy} className="space-y-4">
      <label className="block text-sm">الفرع<select required disabled={ctx.role !== 'owner'} value={store} onChange={e => setStore(e.target.value)} className={`${fieldClass} mt-2`}>{ctx.stores.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
      <label className="block text-sm">المبلغ (دج)<input required type="number" min="1" max="2147483647" step="1" value={amount} onChange={e => setAmount(e.target.value)} className={`${fieldClass} mt-2`} /></label>
      <label className="block text-sm">الوصف<textarea required maxLength={1000} value={description} onChange={e => setDescription(e.target.value)} className={`${fieldClass} mt-2`} /></label>
      <label className="block text-sm">إيصال (اختياري)<input type="file" accept="image/jpeg,image/png,image/webp,application/pdf" onChange={e => { const next = e.target.files?.[0] || null; try { validateReceipt(next); setFile(next); setError('') } catch (err) { e.target.value = ''; setFile(null); setError(err.message) } }} className={`${fieldClass} mt-2`} />{file && <span className="mt-2 block break-all text-xs text-gold">المرفق المحدد: {file.name}</span>}</label>
      <p className="text-xs text-neutral-500">حتى 5 ميغابايت · إيصال خاص غير متاح للعامة. سيُسجَّل المصروف فوراً في المحاسبة، دون حركة نقدية إضافية في تقفيلة الصندوق.</p>
      <button className={primaryClass}>{busy ? 'جاري الحفظ...' : 'حفظ المصروف'}</button>
    </fieldset></form></Modal>, document.body)}
  </>
}
