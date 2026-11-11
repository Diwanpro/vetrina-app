'use client'

import { useEffect, useState } from 'react'
import { Modal, Notice, fieldClass, primaryClass, secondaryClass } from '@/components/dashboard/EngineUI'
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
        p_credit: credit.id, p_amount: value, p_request: requestId,
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
      <div className="flex flex-wrap gap-2">
        <button type="button" disabled={busy} className={secondaryClass} onClick={() => setAmount(String(remaining))}>المبلغ كامل</button>
      </div>
      <p className="text-xs text-neutral-500">الدفعة نقدية وتُضاف إلى صندوق الوردية المفتوحة. يجب فتح الصندوق قبل التسجيل.</p>
      <button disabled={busy} className={primaryClass}>{busy ? 'جاري التسجيل...' : 'تسجيل الدفعة'}</button>
    </form>}
  </Modal>
}

// ---------------------------------------------------------------------------
// Customer ledger: totals, payment history and what they bought.
// ---------------------------------------------------------------------------
export function CustomerLedgerModal({ customerId, onClose }) {
  const [data, setData] = useState(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let live = true
    setLoading(true); setError('')
    supabase.rpc('engine_customer_ledger', { p_customer: customerId })
      .then(({ data, error }) => {
        if (error) throw error
        if (live) setData(data)
      })
      .catch(err => { if (live) setError(err.message) })
      .finally(() => { if (live) setLoading(false) })
    return () => { live = false }
  }, [customerId])

  const customer = data?.customer
  return <Modal title="سجل الزبون" onClose={onClose} wide>
    <Notice error={error} />
    {loading && <p className="text-neutral-400">جاري التحميل...</p>}
    {data && <>
      <p className="mb-4 text-sm text-neutral-300">{customer?.name || 'زبون'}{customer?.phone ? ` · ${customer.phone}` : ''}</p>

      <div className="mb-5 grid gap-3 sm:grid-cols-3">
        {[['إجمالي الدين', data.totalDebt, 'text-neutral-100'],
          ['إجمالي المدفوع', data.totalPaid, 'text-emerald-300'],
          ['المتبقي', data.remaining, Number(data.remaining) > 0 ? 'text-red-300' : 'text-emerald-300']].map(([label, value, tone]) =>
          <section key={label} className="rounded-xl border border-white/10 bg-black/20 p-4">
            <h3 className="text-xs text-neutral-500">{label}</h3>
            <p className={`mt-2 text-lg ${tone}`}>{formatDzd(value)}</p>
          </section>)}
      </div>

      <h3 className="mb-2 text-sm text-gold">سجل الدفعات</h3>
      <div className="mb-5 overflow-x-auto">
        <table className="w-full min-w-[420px] text-right text-sm">
          <thead><tr className="text-neutral-500">{['التاريخ', 'المبلغ', 'سجّلها'].map(h => <th key={h} className="p-2 font-normal">{h}</th>)}</tr></thead>
          <tbody>
            {data.payments?.map(row => <tr key={row.id} className="border-t border-white/5 text-neutral-300">
              <td className="whitespace-nowrap p-2">{new Date(row.created_at).toLocaleString('ar-DZ')}</td>
              <td className="p-2 text-emerald-300">{formatDzd(row.amount)}</td>
              <td className="p-2 text-neutral-400">{row.by || '—'}</td>
            </tr>)}
            {!data.payments?.length && <tr><td colSpan={3} className="p-4 text-center text-neutral-500">لا توجد دفعات مسجلة.</td></tr>}
          </tbody>
        </table>
      </div>

      <h3 className="mb-2 text-sm text-gold">المشتريات بالكريدي</h3>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[520px] text-right text-sm">
          <thead><tr className="text-neutral-500">{['التاريخ', 'البيان', 'المبلغ', 'المتبقي', 'الحالة'].map(h => <th key={h} className="p-2 font-normal">{h}</th>)}</tr></thead>
          <tbody>
            {data.credits?.map(row => <tr key={row.id} className="border-t border-white/5 text-neutral-300">
              <td className="whitespace-nowrap p-2">{new Date(row.created_at).toLocaleDateString('ar-DZ')}</td>
              <td className="max-w-xs break-words p-2">{row.description || 'دين بدون بيان'}</td>
              <td className="p-2">{formatDzd(row.total)}</td>
              <td className={`p-2 ${Number(row.remaining) > 0 ? 'text-red-300' : 'text-emerald-300'}`}>{formatDzd(row.remaining)}</td>
              <td className="p-2 text-xs text-neutral-400">{row.status === 'paid' ? 'مسدد' : 'قائم'}</td>
            </tr>)}
            {!data.credits?.length && <tr><td colSpan={5} className="p-4 text-center text-neutral-500">لا توجد ديون.</td></tr>}
          </tbody>
        </table>
      </div>
    </>}
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
