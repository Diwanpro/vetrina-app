'use client'

import { useEffect, useState } from 'react'
import { Modal, Notice, fieldClass, primaryClass, secondaryClass } from '@/components/dashboard/EngineUI'
import { supabase } from '@/lib/supabase'
import { formatDzd } from '@/lib/app-context'
import { validMoney } from '@/lib/cash'

function newRequestId() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID()
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`
}

// Supplier ledger: totals, invoices, payments, and a payment form that stays
// inside the modal so the owner never loses context by navigating away.
export default function SupplierLedger({ supplier, onClose, onPaid }) {
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')
  const [paying, setPaying] = useState(false)
  const [amount, setAmount] = useState('')
  const [busy, setBusy] = useState(false)
  const [requestId, setRequestId] = useState(newRequestId)

  async function load() {
    setLoading(true); setError('')
    try {
      const { data, error } = await supabase.rpc('engine_supplier_ledger', { p_supplier: supplier.id })
      if (error) throw error
      setData(data)
    } catch (err) { setError(err.message) } finally { setLoading(false) }
  }

  useEffect(() => { load() }, [supplier.id])

  async function submitPayment(event) {
    event.preventDefault()
    const value = Number(String(amount).replace(/[^0-9]/g, ''))
    if (!validMoney(value) || value <= 0) { setError('أدخل مبلغاً موجباً'); return }
    if (value > Number(data?.supplier?.totalDebt || 0)) { setError('المبلغ أكبر من الدين المتبقي'); return }
    setBusy(true); setError(''); setSuccess('')
    try {
      const { error } = await supabase.rpc('engine_pay_supplier', {
        p_supplier: supplier.id,
        p_store: supplier.store_id,
        p_request: requestId,
        p_amount: value,
        p_tenant: supplier.tenant_id,
      })
      if (error) throw error
      setAmount(''); setPaying(false); setRequestId(newRequestId())
      setSuccess('تم تسجيل الدفعة')
      window.dispatchEvent(new Event('vetrina:finance'))
      await load()
      onPaid?.()
    } catch (err) { setError(err.message) } finally { setBusy(false) }
  }

  const s = data?.supplier
  return <Modal title={`سجل المورد · ${supplier.name}`} onClose={onClose} busy={busy} wide>
    <Notice error={error} success={success} />
    {loading && <p className="text-neutral-400">جاري التحميل...</p>}
    {data && <>
      <div className="mb-5 grid gap-3 sm:grid-cols-3">
        {[['إجمالي المشتريات', data.totalPurchases, 'text-neutral-100'],
          ['إجمالي المدفوع', data.totalPaid, 'text-emerald-300'],
          ['الدين المتبقي', data.remaining, Number(data.remaining) > 0 ? 'text-red-300' : 'text-emerald-300']].map(([label, value, tone]) =>
          <section key={label} className="rounded-xl border border-white/10 bg-black/20 p-4">
            <h3 className="text-xs text-neutral-500">{label}</h3>
            <p className={`mt-2 text-lg ${tone}`}>{formatDzd(value)}</p>
          </section>)}
      </div>

      {s?.phone && <p className="mb-4 text-sm text-neutral-400">الهاتف: <span dir="ltr">{s.phone}</span></p>}

      {!paying && <button disabled={busy || Number(data.remaining || 0) <= 0}
        onClick={() => { setPaying(true); setError(''); setSuccess('') }} className={`${primaryClass} mb-5`}>
        تسجيل دفعة
      </button>}

      {Number(data.remaining || 0) <= 0 && !paying && <p className="mb-5 text-xs text-emerald-300">الدين مسدد بالكامل.</p>}

      {paying && <form onSubmit={submitPayment} className="mb-5 space-y-3 rounded-xl border border-gold/20 bg-black/20 p-4">
        <p className="text-sm text-gold">الدين المتبقي: {formatDzd(data.remaining)}</p>
        <label className="block text-sm text-neutral-300">مبلغ الدفعة
          <input inputMode="numeric" required autoFocus disabled={busy} value={amount}
            onChange={e => setAmount(e.target.value.replace(/[^0-9]/g, ''))}
            className={`${fieldClass} mt-1`} placeholder="0" />
        </label>
        <div className="flex flex-wrap gap-2">
          <button type="button" disabled={busy} className={secondaryClass} onClick={() => setAmount(String(data.remaining))}>المبلغ كامل</button>
          <button disabled={busy} className={primaryClass}>{busy ? 'جاري الحفظ...' : 'تأكيد الدفعة'}</button>
          <button type="button" disabled={busy} className={secondaryClass} onClick={() => { setPaying(false); setAmount('') }}>إلغاء</button>
        </div>
      </form>}

      <h3 className="mb-2 text-sm text-gold">فواتير الشراء</h3>
      <div className="mb-5 overflow-x-auto">
        <table className="w-full min-w-[420px] text-right text-sm">
          <thead><tr className="text-neutral-500">{['التاريخ', 'المبلغ', 'الحالة'].map(h => <th key={h} className="p-2 font-normal">{h}</th>)}</tr></thead>
          <tbody>
            {data.purchases?.map(row => <tr key={row.id} className="border-t border-white/5 text-neutral-300">
              <td className="whitespace-nowrap p-2">{new Date(row.created_at).toLocaleDateString('ar-DZ')}</td>
              <td className="p-2">{formatDzd(row.amount)}</td>
              <td className="p-2 text-xs text-neutral-400">{row.status === 'received' ? 'مستلمة' : row.status}</td>
            </tr>)}
            {!data.purchases?.length && <tr><td colSpan={3} className="p-4 text-center text-neutral-500">لا توجد فواتير.</td></tr>}
          </tbody>
        </table>
      </div>

      <h3 className="mb-2 text-sm text-gold">سجل الدفعات</h3>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[420px] text-right text-sm">
          <thead><tr className="text-neutral-500">{['التاريخ', 'المبلغ', 'سجّلها'].map(h => <th key={h} className="p-2 font-normal">{h}</th>)}</tr></thead>
          <tbody>
            {data.payments?.map(row => <tr key={row.id} className="border-t border-white/5 text-neutral-300">
              <td className="whitespace-nowrap p-2">{new Date(row.created_at).toLocaleString('ar-DZ')}</td>
              <td className="p-2 text-emerald-300">{formatDzd(row.amount)}</td>
              <td className="p-2 text-neutral-400">{row.by || '—'}</td>
            </tr>)}
            {!data.payments?.length && <tr><td colSpan={3} className="p-4 text-center text-neutral-500">لا توجد دفعات.</td></tr>}
          </tbody>
        </table>
      </div>
    </>}
  </Modal>
}
