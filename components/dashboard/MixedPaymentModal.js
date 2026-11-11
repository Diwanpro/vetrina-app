'use client'

import { useState } from 'react'
import { Modal, Notice, fieldClass, selectClass, primaryClass, secondaryClass } from '@/components/dashboard/EngineUI'
import { supabase } from '@/lib/supabase'
import { formatDzd } from '@/lib/app-context'

const BUCKET = 'receipts'
const MAX_BYTES = 5 * 1024 * 1024

// Splits the unpaid remainder of an invoice into a debt or a cheque/CCP receipt.
// The money never enters the drawer here: a cheque is only paper until it clears,
// and credit is owed by the customer. Collection is a separate step.
export default function MixedPaymentModal({ ctx, remainder, onCancel, onConfirm }) {
  const [method, setMethod] = useState('credit')
  // { id, name, phone }. `id` is set only when an existing customer was picked;
  // when null the server creates the row from the typed name.
  const [customer, setCustomer] = useState({ id: null, name: '', phone: '' })
  const [file, setFile] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const isPaper = method === 'check' || method === 'ccp'

  async function upload() {
    if (!file) throw new Error('أرفق صورة الشيك أو الوصل')
    if (file.size > MAX_BYTES) throw new Error('حجم الملف أكبر من 5 ميغابايت')
    if (!/^image\/(jpeg|png|webp)$|^application\/pdf$/.test(file.type)) {
      throw new Error('الصيغة يجب أن تكون JPG أو PNG أو WebP أو PDF')
    }
    const extension = (file.name.split('.').pop() || 'jpg').toLowerCase().replace(/[^a-z0-9]/g, '')
    const path = `${ctx.tenantId}/${ctx.storeId}/${Date.now()}-${crypto.randomUUID()}.${extension}`
    const { error: uploadError } = await supabase.storage.from(BUCKET).upload(path, file, { upsert: false, contentType: file.type })
    if (uploadError) throw new Error(`تعذر رفع الوصل: ${uploadError.message}`)
    return path
  }

  async function submit(event) {
    event.preventDefault()
    setError('')
    // Each method has its own mandatory field; validate before touching storage
    // so a rejected form never leaves an orphaned upload behind.
    if (isPaper && !file) { setError('أرفق صورة الشيك أو الوصل'); return }
    if (!isPaper && !String(customer.name || '').trim()) { setError('اسم الزبون مطلوب'); return }
    setBusy(true)
    try {
      const receiptPath = isPaper ? await upload() : null
      await onConfirm({
        cash: 0, // filled in by the caller with the amount actually taken
        amount: remainder,
        method,
        customer_name: String(customer.name || '').trim(),
        customer_phone: String(customer.phone || '').trim(),
        // Carried through to the sync call so an existing row is reused instead
        // of being looked up by name again and possibly duplicated.
        customer_id: customer.id || null,
        receipt_url: receiptPath,
      })
    } catch (err) { console.error('[pos] mixed payment failed', err); setError(err.message) }
    finally { setBusy(false) }
  }

  return <div className="fixed inset-0 z-[60]">
    <Modal title="تسديد المبلغ المتبقي" busy={busy} onClose={onCancel}>
    <p className="mb-4 rounded-lg border border-amber-700/30 bg-amber-950/20 p-3 text-sm leading-6 text-amber-200">
        المبلغ المتبقي: <span className="font-medium">{formatDzd(remainder)}</span> دج. كيف تريد تسديده؟
    </p>
    <Notice error={error} />
    <form onSubmit={submit} className="space-y-3">
        <label className="block text-sm text-neutral-300">طريقة التسديد
          <select value={method} disabled={busy} onChange={e => setMethod(e.target.value)} className={`${selectClass} mt-1`}>
            <option value="credit">كريدي</option>
            <option value="check">شيك</option>
            <option value="ccp">بريدي</option>
          </select>
        </label>

        <div className="block text-sm text-neutral-300">
          <span className="mb-1 block">اسم الزبون {!isPaper && <span className="text-red-300">*</span>}</span>
          <CustomerPicker tenantId={ctx.tenantId} value={customer} onChange={setCustomer} disabled={busy} />
        </div>

        {isPaper && <label className="block text-sm text-neutral-300">أرفق صورة الشيك / الوصل <span className="text-red-300">*</span>
          <input required type="file" disabled={busy} accept="image/jpeg,image/png,image/webp,application/pdf"
            onChange={e => setFile(e.target.files?.[0] || null)} className={`${fieldClass} mt-1`} />
          {file && <span className="mt-1 block break-all text-xs text-gold">{file.name}</span>}
        </label>}

        <p className="rounded border border-white/10 bg-black/20 p-2 text-[11px] leading-5 text-neutral-400">
          {isPaper
            ? 'الشيك أو الوصل لا يدخل الصندوق قبل التحصيل. بعد التحصيل يظهر في صفحة التحصيلات.'
            : 'يُسجَّل المبلغ ديناً على الزبون في صفحة الكريدي، ولا يدخل الصندوق.'}
        </p>

        <div className="flex flex-wrap gap-2">
          <button disabled={busy} className={primaryClass}>{busy ? 'جاري الحفظ...' : 'تأكيد وإتمام البيع'}</button>
          <button type="button" disabled={busy} onClick={onCancel} className={secondaryClass}>إلغاء</button>
        </div>
      </form>
    </Modal>
  </div>
}
