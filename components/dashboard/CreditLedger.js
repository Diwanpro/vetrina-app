'use client'

import { useEffect, useState } from 'react'
import { Modal, Notice, fieldClass, primaryClass, secondaryClass, selectClass } from '@/components/dashboard/EngineUI'
import CustomSelect from '@/components/ui/CustomSelect'
import { supabase } from '@/lib/supabase'
import { formatDzd } from '@/lib/app-context'

// Rounding guard: money is integer dinars in this schema.
function toAmount(value) {
  const digits = String(value ?? '').replace(/[^0-9]/g, '')
  return digits ? Number(digits) : NaN
}

function IdempotencyKey() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID()
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`
}

// ---------------------------------------------------------------------------
// Record a credit payment. The database enforces the open shift and the
// remaining balance; this form only collects the amount.
// ---------------------------------------------------------------------------
export function CreditPaymentModal({ credit, onClose, onSaved }) {
  const [amount, setAmount] = useState('')
  const [method, setMethod] = useState('cash')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [done, setDone] = useState(null)
  // A stable key per attempt: a double click replays instead of double-charging.
  const [requestId] = useState(IdempotencyKey)

  const remaining = Number(credit?.remaining_amount ?? credit?.total_amount ?? 0)
  const customer = credit?.customers?.name || 'زبون'

  async function submit(event) {
    event.preventDefault()
    const value = toAmount(amount)
    if (!value || value <= 0) { setError('أدخل مبلغاً موجباً'); return }
    if (value > remaining) { setError(`المبلغ أكبر من المتبقي (${formatDzd(remaining)})`); return }
    setBusy(true); setError('')
    try {
      const { data, error } = await supabase.rpc('engine_credit_payment', {
        p_credit: credit.id, p_amount: value, p_request: requestId, p_method: method,
      })
      if (error) throw error
      if (!data?.ok) throw new Error(data?.error || 'تعذر تسجيل الدفعة')
      setDone(data)
      // Dashboard banner: "دفعة كريدي: [الزبون] - [المبلغ]"
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('vetrina:credit-payment', {
          detail: { customer: data.customer || customer, amount: data.amount, remaining: data.remaining },
        }))
        window.dispatchEvent(new Event('vetrina:finance'))
      }
      onSaved?.(data)
    } catch (err) { setError(err.message) } finally { setBusy(false) }
  }

  return <Modal title="تسجيل دفعة" onClose={onClose} busy={busy}>
    <p className="mb-4 text-sm text-neutral-400">{customer} · المتبقي {formatDzd(remaining)}</p>
    {done ? <div className="space-y-4">
      <p className="rounded-lg border border-emerald-800/40 bg-emerald-950/20 p-3 text-sm text-emerald-200">
        تم تسجيل دفعة كريدي: {done.customer || customer} - {formatDzd(done.amount)}
        {Number(done.remaining) > 0 ? ` · المتبقي ${formatDzd(done.remaining)}` : ' · سُدّد الدين بالكامل'}
      </p>
      <p className="text-xs text-neutral-500">أُضيفت الدفعة إلى صندوق الوردية المفتوحة، وستظهر في النقد المتوقع عند التقفيلة.</p>
      <button className={primaryClass} onClick={onClose}>تم</button>
    </div> : <form onSubmit={submit} className="space-y-4">
      <Notice error={error} />
      <label className="block text-sm text-neutral-300">المبلغ المدفوع
        <input inputMode="numeric" required autoFocus disabled={busy} value={amount}
          onChange={e => setAmount(e.target.value.replace(/[^0-9]/g, ''))}
          placeholder="0" className={`${fieldClass} mt-1`} />
      </label>
      <label className="block text-sm text-neutral-300">طريقة الدفع
        <CustomSelect disabled={busy} value={method} onChange={e => setMethod(e)} options={[
          { label: 'نقداً (يُضاف للصندوق)', value: 'cash' },
          { label: 'شيك', value: 'check' },
          { label: 'CCP', value: 'ccp' }
        ]} className={`${selectClass} mt-1`} />
      </label>
      <div className="flex flex-wrap gap-2">
        <button type="button" disabled={busy} className={secondaryClass} onClick={() => setAmount(String(remaining))}>المبلغ كامل</button>
      </div>
      <p className="text-xs text-neutral-500">الدفعة النقدية تُضاف إلى صندوق الوردية المفتوحة. الشيك وCCP يُسجّلان بدون زيادة النقد.</p>
      <button disabled={busy} className={primaryClass}>{busy ? 'جاري التسجيل...' : 'تسجيل الدفعة'}</button>
    </form>}
  </Modal>
}

// ---------------------------------------------------------------------------
// Dashboard banner for a recorded credit payment. Listens on window so any page
// (including the POS) can announce cash landing in the drawer.
// ---------------------------------------------------------------------------
export function CreditPaymentToast() {
  const [messages, setMessages] = useState([])

  useEffect(() => {
    function onPayment(event) {
      const detail = event.detail || {}
      const id = `${Date.now()}-${Math.random().toString(16).slice(2)}`
      setMessages(current => [...current, {
        id,
        text: `دفعة كريدي: ${detail.customer || 'زبون'} - ${formatDzd(detail.amount)}`,
      }].slice(-3))
      // Auto-dismiss so the banner never becomes permanent furniture.
      setTimeout(() => setMessages(current => current.filter(item => item.id !== id)), 12000)
    }
    window.addEventListener('vetrina:credit-payment', onPayment)
    return () => window.removeEventListener('vetrina:credit-payment', onPayment)
  }, [])

  if (!messages.length) return null
  return <div className="space-y-2" role="status" aria-live="polite">
    {messages.map(item => <div key={item.id} className="flex items-start justify-between gap-3 rounded-lg border border-emerald-700/40 bg-emerald-950/30 px-3 py-2 text-sm text-emerald-200">
      <span>{item.text}</span>
      <button type="button" onClick={() => setMessages(current => current.filter(row => row.id !== item.id))}
        className="text-xs text-emerald-300/70 hover:text-emerald-100">إخفاء</button>
    </div>)}
  </div>
}
