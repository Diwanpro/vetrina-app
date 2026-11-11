'use client'

import { useCallback, useEffect, useState } from 'react'
import { Modal, Notice, primaryClass, secondaryClass, fieldClass, selectClass } from '@/components/dashboard/EngineUI'
import { supabase } from '@/lib/supabase'
import { formatDzd } from '@/lib/app-context'

const KINDS = {
  purchase: 'text-amber-200',
  payment: 'text-emerald-300',
  pending: 'text-sky-300',
  credit: 'text-amber-200',
}

function day(value) {
  return value ? new Date(value).toLocaleDateString('ar-DZ') : '—'
}

function newRequestId() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID()
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`
}

function toAmount(value) {
  const digits = String(value ?? '').replace(/[^0-9]/g, '')
  return digits ? Number(digits) : NaN
}

// One modal for both ledgers: the two RPCs return the same entry shape, so the
// table is written once and cannot drift between customers and suppliers.
export default function LedgerModal({ kind, id, onClose, onPay }) {
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  // Sub-modal state for Customer Ledger payment
  const [paying, setPaying] = useState(false)
  const [amount, setAmount] = useState('')
  const [method, setMethod] = useState('cash')
  const [busy, setBusy] = useState(false)
  const [requestId, setRequestId] = useState(newRequestId)
  const [payError, setPayError] = useState('')
  const [paySuccess, setPaySuccess] = useState('')

  const load = useCallback(async () => {
    setLoading(true); setError('')
    try {
      const { data: result, error: rpcError } = await supabase.rpc(
        kind === 'supplier' ? 'engine_supplier_ledger_detail' : 'engine_customer_ledger_detail',
        kind === 'supplier' ? { p_supplier: id } : { p_customer: id })
      if (rpcError) throw rpcError
      setData(result)
    } catch (err) { setError(err.message) } finally { setLoading(false) }
  }, [kind, id])

  useEffect(() => { load() }, [load])

  const party = data?.supplier || data?.customer
  const entries = data?.entries || []
  const cash = entries.reduce((sum, row) => sum + Number(row.cash || 0), 0)
  const paper = entries.reduce((sum, row) => sum + Number(row.paper || 0), 0)
  const total = entries.reduce((sum, row) => sum + Number(row.total || 0), 0)
  const remaining = Number(data?.remaining || 0)

  // Submit payment for Customer Ledger
  const submitCustomerPayment = useCallback(async (event) => {
    event.preventDefault()
    const value = toAmount(amount)
    if (!value || value <= 0) { setPayError('أدخل مبلغاً موجباً'); return }
    if (value > remaining) { setPayError(`المبلغ أكبر من المتبقي (${formatDzd(remaining)})`); return }
    
    setBusy(true); setPayError(''); setPaySuccess('')
    try {
      const { data: rpcData, error: rpcError } = await supabase.rpc('engine_credit_payment', {
        p_credit: id, // credit_id is the customer ledger id in this context
        p_amount: value,
        p_request: requestId,
        p_method: method,
      })
      if (rpcError) throw rpcError
      if (!rpcData?.ok) throw new Error(rpcData?.error || 'تعذر تسجيل الدفعة')
      
      setPaySuccess('تم تسجيل الدفعة')
      window.dispatchEvent(new Event('vetrina:finance'))
      window.dispatchEvent(new CustomEvent('vetrina:credit-payment', {
        detail: { customer: party?.name || 'زبون', amount: value, remaining: rpcData?.remaining },
      }))
      
      // Refresh the ledger modal immediately
      await load()
      onPay?.(party)
      
      // Reset sub-modal
      setPaying(false)
      setAmount('')
      setRequestId(newRequestId())
      setMethod('cash')
    } catch (err) { setPayError(err.message) } finally { setBusy(false) }
  }, [amount, method, requestId, remaining, id, party, load, onPay])

  return <Modal title={`سجل ${kind === 'supplier' ? 'المورد' : 'الزبون'} · ${party?.name || ''}`} onClose={onClose} wide busy={busy}>\n    <Notice error={error || payError} success={paySuccess} />

    <div className=\"mb-4 flex flex-wrap items-center justify-between gap-3\">\n      <div className=\"flex flex-wrap gap-3\">\n        {[['إجمالي الدين', total, 'text-neutral-100'],\n          ['المدفوع نقداً', cash, 'text-emerald-300'],\n          ['شيك / CCP', paper, 'text-sky-300'],\n          ['المتبقي', remaining, remaining > 0 ? 'text-red-300' : 'text-emerald-300']]\n          .map(([label, value, tone]) => <section key={label} className=\"rounded-xl border border-white/10 bg-black/20 px-3 py-2\">\n            <h3 className=\"text-[11px] text-neutral-500\">{label}</h3>\n            <p className={`mt-1 text-sm ${tone}`}>{formatDzd(value)}</p>\n          </section>)}\n      </div>
      
      {kind === 'customer' && !paying && remaining > 0 && (\n        <button type=\"button\" onClick={() => { setPaying(true); setPayError(''); setPaySuccess('') }} className={primaryClass}>تسجيل دفعة</button>\n      )}
      
      {kind === 'supplier' && onPay && <button type=\"button\" onClick={() => onPay(party)} className={primaryClass}>تسجيل دفعة</button>}\n    </div>

    {party?.phone && <p className=\"mb-3 text-sm text-neutral-400\">الهاتف: <span dir=\"ltr\">{party.phone}</span></p>}\n

    {paying && kind === 'customer' ? (\n      <form onSubmit={submitCustomerPayment} className=\"mb-5 space-y-3 rounded-xl border border-gold/20 bg-black/20 p-4\">\n        <p className=\"text-sm text-gold\">المتبقي: {formatDzd(remaining)}</p>\n        <label className=\"block text-sm text-neutral-300\">مبلغ الدفعة\n          <input inputMode=\"numeric\" required autoFocus disabled={busy} value={amount}\n            onChange={e => setAmount(e.target.value.replace(/[^0-9]/g, ''))}\n            className={`${fieldClass} mt-1`} placeholder=\"0\" />\n        </label>\n        <label className=\"block text-sm text-neutral-300\">طريقة الدفع\n          <select disabled={busy} value={method} onChange={e => setMethod(e.target.value)} className={`${selectClass} mt-1`}>\n            <option value=\"cash\">نقداً (يُضاف للصندوق)</option>\n            <option value=\"check\">شيك</option>\n            <option value=\"ccp\">CCP</option>\n          </select>\n        </label>\n        <div className=\"flex flex-wrap gap-2\">\n          <button type=\"button\" disabled={busy} className={secondaryClass} onClick={() => setAmount(String(remaining))}>المبلغ كامل</button>\n          <button disabled={busy} className={primaryClass}>{busy ? 'جاري التسجيل...' : 'تأكيد الدفعة'}</button>\n          <button type=\"button\" disabled={busy} className={secondaryClass} onClick={() => { setPaying(false); setAmount(''); setPayError(''); setPaySuccess('') }}>إلغاء</button>\n        </div>\n      </form>\n    ) : loading ? <p className=\"text-sm text-neutral-400\">جاري التحميل...</p>\n      : !entries.length ? <p className=\"text-sm text-neutral-500\">لا توجد حركات مسجلة بعد.</p>\n      : <div className=\"overflow-x-auto\">\n        <table className=\"w-full min-w-[720px] text-right text-xs\">\n          <thead>\n            <tr className=\"text-neutral-500\">\n              {['التاريخ', 'البيان', 'الإجمالي', 'المدفوع نقداً', 'شيك / CCP', 'المتبقي'].map(h =>\n                <th key={h} className=\"whitespace-nowrap p-2 font-normal\">{h}</th>)}\n            </tr>\n          </thead>\n          {/* Oldest to newest, so the running balance reads top to bottom. */}\n          <tbody>\n            {entries.map((row, index) => <tr key={`${row.date}-${row.kind}-${index}`} className=\"border-t border-white/5\">\n              <td className=\"whitespace-nowrap p-2 text-neutral-400\">{day(row.date)}</td>\n              <td className=\"p-2\">\n                <span className={KINDS[row.kind] || 'text-neutral-300'}>{row.label}</span>\n                {row.detail && <span className=\"block truncate text-[11px] text-neutral-500\">{row.detail}</span>}\n              </td>\n              <td className=\"whitespace-nowrap p-2 text-neutral-200\">{row.total ? formatDzd(row.total) : '—'}</td>\n              <td className=\"whitespace-nowrap p-2 text-emerald-300\">{row.cash ? formatDzd(row.cash) : '—'}</td>\n              <td className=\"whitespace-nowrap p-2 text-sky-300\">{row.paper ? formatDzd(row.paper) : '—'}</td>\n              <td className={`whitespace-nowrap p-2 font-medium ${remaining > 0 ? 'text-gold' : 'text-emerald-300'}`}>\n                {formatDzd(remaining)}\n              </td>\n            </tr>)}\n          </tbody>\n        </table>\n      </div>}\n

    <div className=\"mt-4 flex justify-end\">\n      <button type=\"button\" onClick={onClose} className={secondaryClass}>إغلاق</button>\n    </div>\n  </Modal>\n}
