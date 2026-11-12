'use client'

import { useCallback, useEffect, useState } from 'react'
import { Modal, Notice, primaryClass, secondaryClass, fieldClass, selectClass } from '@/components/dashboard/EngineUI'
import CustomSelect from '@/components/ui/CustomSelect'
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

  return (
    <Modal title={`سجل ${kind === 'supplier' ? 'المورد' : 'الزبون'} · ${party?.name || ''}`} onClose={onClose} wide busy={busy}>
      <Notice error={error || payError} success={paySuccess} />

      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap gap-3">
          {[['إجمالي الدين', total, 'text-neutral-100'],
            ['المدفوع نقداً', cash, 'text-emerald-300'],
            ['شيك / CCP', paper, 'text-sky-300'],
            ['المتبقي', remaining, remaining > 0 ? 'text-red-300' : 'text-emerald-300']]
            .map(([label, value, tone]) => (
              <section key={label} className="rounded-xl border border-white/10 bg-black/20 px-3 py-2">
                <h3 className="text-[11px] text-neutral-500">{label}</h3>
                <p className={`mt-1 text-sm ${tone}`}>{formatDzd(value)}</p>
              </section>
            ))}
        </div>
        
        {kind === 'customer' && !paying && remaining > 0 && (
          <button type="button" onClick={() => { setPaying(true); setPayError(''); setPaySuccess('') }} className={primaryClass}>تسجيل دفعة</button>
        )}
        
        {kind === 'supplier' && onPay && <button type="button" onClick={() => onPay(party)} className={primaryClass}>تسجيل دفعة</button>}
      </div>

      {party?.phone && <p className="mb-3 text-sm text-neutral-400">الهاتف: <span dir="ltr">{party.phone}</span></p>}

      {paying && kind === 'customer' ? (
        <form onSubmit={submitCustomerPayment} className="mb-5 space-y-3 rounded-xl border border-gold/20 bg-black/20 p-4">
          <p className="text-sm text-gold">المتبقي: {formatDzd(remaining)}</p>
          <label className="block text-sm text-neutral-300">مبلغ الدفعة
            <input inputMode="numeric" required autoFocus disabled={busy} value={amount}
              onChange={e => setAmount(e.target.value.replace(/[^0-9]/g, ''))}
              className={`${fieldClass} mt-1`} placeholder="0" />
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
            <button disabled={busy} className={primaryClass}>{busy ? 'جاري التسجيل...' : 'تأكيد الدفعة'}</button>
            <button type="button" disabled={busy} className={secondaryClass} onClick={() => { setPaying(false); setAmount(''); setPayError(''); setPaySuccess('') }}>إلغاء</button>
          </div>
        </form>
      ) : loading ? <p className="text-sm text-neutral-400">جاري التحميل...</p>
      : !entries.length ? <p className="text-sm text-neutral-500">لا توجد حركات مسجلة بعد.</p>
      : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[720px] text-right text-xs">
            <thead>
              <tr className="text-neutral-500">
                {['التاريخ', 'البيان', 'الإجمالي', 'المدفوع نقداً', 'شيك / CCP', 'المتبقي'].map(h =>
                  <th key={h} className="whitespace-nowrap p-2 font-normal">{h}</th>)}
              </tr>
            </thead>
            {/* Oldest to newest, so the running balance reads top to bottom. */}
            <tbody>
              {entries.map((row, index) => (
                <tr key={`${row.date}-${row.kind}-${index}`} className="border-t border-white/5">
                  <td className="whitespace-nowrap p-2 text-neutral-400">{day(row.date)}</td>
                  <td className="p-2">
                    <span className={KINDS[row.kind] || 'text-neutral-300'}>{row.label}</span>
                    {row.detail && <span className="block truncate text-[11px] text-neutral-500">{row.detail}</span>}
                  </td>
                  <td className="whitespace-nowrap p-2 text-neutral-200">{row.total ? formatDzd(row.total) : '—'}</td>
                  <td className="whitespace-nowrap p-2 text-emerald-300">{row.cash ? formatDzd(row.cash) : '—'}</td>
                  <td className="whitespace-nowrap p-2 text-sky-300">{row.paper ? formatDzd(row.paper) : '—'}</td>
                  <td className={`whitespace-nowrap p-2 font-medium ${remaining > 0 ? 'text-gold' : 'text-emerald-300'}`}>
                    {formatDzd(remaining)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="mt-4 flex justify-end">
        <button type="button" onClick={onClose} className={secondaryClass}>إغلاق</button>
      </div>
    </Modal>
  )
}
