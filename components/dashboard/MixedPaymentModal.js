'use client'

import { useState } from 'react'
import { Modal, Notice, fieldClass, selectClass, primaryClass, secondaryClass } from '@/components/dashboard/EngineUI'
import CustomSelect from '@/components/ui/CustomSelect'
import { supabase } from '@/lib/supabase'
import { formatDzd } from '@/lib/app-context'
import CustomerPicker from '@/components/dashboard/CustomerPicker'

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

  // A credit sale is only submittable once a customer is genuinely resolved:
  // either an existing row was picked (id present) or a name was typed for a
  // new one. Reading `customer.id` off an unresolved value is what black-screened
  // the till, so every read below is guarded.
  const customerName = typeof customer?.name === 'string' ? customer.name.trim() : ''
  const customerId = typeof customer?.id === 'string' && customer.id ? customer.id : null
  const creditReady = isPaper ? Boolean(file) : Boolean(customerName || customerId)

  async function submit(event) {
    event.preventDefault()
    if (busy) return
    setError('')

    if (isPaper && !file) { setError('أرفق صورة الشيك أو الوصل'); return }
    if (!isPaper && !customerName && !customerId) { setError('اختر زبوناً أو أنشئ زبوناً جديداً'); return }

    setBusy(true)
    try {
      const receiptPath = isPaper ? await upload() : null

      // onConfirm resolves once the sale is stored locally; a thrown error means
      // it was not, and the modal must stay open with the reason.
      await onConfirm({
        cash: 0, // filled in by the caller with the amount actually taken
        amount: remainder,
        method,
        customer_name: customerName,
        customer_phone: typeof customer?.phone === 'string' ? customer.phone.trim() : '',
        // Carried through to the sync call so an existing row is reused instead
        // of being looked up by name again and possibly duplicated.
        customer_id: customerId,
        receipt_url: receiptPath,
      })
    } catch (err) {
      console.error('[pos] mixed payment failed', err)
      const message = typeof err?.message === 'string' && err.message.trim()
        ? err.message
        : 'تعذر تسجيل الدفعة، تحقق من الاتصال وأعد المحاولة'
      setError(message.includes('fetch') || message.includes('network') || message.includes('الإتصال')
        ? 'تعذر تسجيل الدفعة، تحقق من الاتصال وأعد المحاولة'
        : message)
    } finally { setBusy(false) }
  }

  return <div className="fixed inset-0 z-[60]">
    <Modal title="تسديد المبلغ المتبقي" busy={busy} onClose={onCancel}>
    <p className="mb-4 rounded-lg border border-amber-700/30 bg-amber-950/20 p-3 text-sm leading-6 text-amber-200">
        المبلغ المتبقي: <span className="font-medium">{formatDzd(remainder)}</span> دج. كيف تريد تسديده؟
    </p>
    <Notice error={error} />
    <form onSubmit={submit} className="space-y-3">
        <label className="block text-sm text-neutral-300">طريقة التسديد
          <CustomSelect value={method} disabled={busy} onChange={e => setMethod(e)} options={[
            { label: 'كريدي', value: 'credit' },
            { label: 'شيك', value: 'check' },
            { label: 'بريدي', value: 'ccp' }
          ]} className={`${selectClass} mt-1`} />
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
          <button disabled={busy || !creditReady} className={primaryClass}>
          {busy ? 'جاري الحفظ...' : !creditReady && !isPaper ? 'اختر الزبون أولاً' : 'تأكيد وإتمام البيع'}
        </button>
          <button type="button" disabled={busy} onClick={onCancel} className={secondaryClass}>إلغاء</button>
        </div>
      </form>
    </Modal>
  </div>
}
