'use client'

import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { supabase } from '@/lib/supabase'
import { getAppContext, formatDzd } from '@/lib/app-context'
import { DENOMINATIONS, countCash, validMoney, fetchAllRows, cashReconciliation, expectedCash } from '@/lib/cash'

const inputClass = 'w-full rounded-lg border border-neutral-700 bg-[#141414] px-3 py-2 text-sm outline-none focus:border-gold'

export default function ShiftManager() {
  const [shift, setShift] = useState(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [modal, setModal] = useState(false)
  const [starting, setStarting] = useState('')
  const [counts, setCounts] = useState({})
  const [notes, setNotes] = useState('')
  const [cashSales, setCashSales] = useState(0)
  const [drawerExpenses, setDrawerExpenses] = useState(0)
  const [ready, setReady] = useState(false)
  const [error, setError] = useState('')
  const actual = countCash(counts)
  const expected = expectedCash({
    openingFloat: shift?.expected_cash,
    cashSales,
    creditPayments: shift?.total_credit_payments,
    collections: shift?.total_collections,
    employeePayments: shift?.total_employee_payments,
    expenses: drawerExpenses,
  })
  const difference = actual - expected

  async function context() {
    const ctx = await getAppContext()
    if (!ctx.user || !ctx.storeId) throw new Error('تعذر تحديد المستخدم أو المتجر')
    return ctx
  }

  async function readShift(storeId) {
    const { data, error } = await supabase.from('shifts').select('*')
      .eq('store_id', storeId).eq('status', 'open').maybeSingle()
    if (error) throw error
    return data
  }

  async function refresh() {
    setLoading(true)
    try {
      const ctx = await context()
      setShift(await readShift(ctx.storeId))
      setError('')
    } catch (err) { setError(err.message) }
    finally { setLoading(false) }
  }

  useEffect(() => {
    refresh()
    const onFocus = () => refresh()
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [])

  async function salesForShift(current, storeId, until) {
    // Use the shift's actual opening time: avoids double-counting when reopening
    // and retains sales on shifts carried across midnight.
    // cash_amount is the portion actually handed over. Summing total_amount
    // counted the cheque/credit part of a mixed ticket as drawer cash.
    const rows = await fetchAllRows(supabase.from('sales').select('id, cash_amount')
      .eq('store_id', storeId).eq('status', 'completed')
      .gte('created_at', current.start_time).lt('created_at', until).order('id'))
    return rows.reduce((sum, row) => sum + Number(row.cash_amount || 0), 0)
  }

  async function expensesForShift(current, storeId, until) {
    // Expenses were never deducted, so the drawer always looked short by the
    // amount spent from it during the shift.
    const rows = await fetchAllRows(supabase.from('expenses').select('id, amount')
      .eq('store_id', storeId).is('deleted_at', null)
      .gte('created_at', current.start_time).lt('created_at', until).order('id'))
    return rows.reduce((sum, row) => sum + Number(row.amount || 0), 0)
  }

  async function openModal() {
    setModal(true)
    setReady(false)
    setCounts({})
    setNotes('')
    setStarting('')
    setBusy(true)
    setError('')
    try {
      const ctx = await context()
      const current = await readShift(ctx.storeId)
      setShift(current)
      if (current) {
        const until = new Date().toISOString()
        const [sales, spent] = await Promise.all([
          salesForShift(current, ctx.storeId, until),
          expensesForShift(current, ctx.storeId, until),
        ])
        setCashSales(sales); setDrawerExpenses(spent)
      } else { setCashSales(0); setDrawerExpenses(0) }
      setReady(true)
    } catch (err) { setError(err.message) }
    finally { setBusy(false) }
  }

  async function save(event) {
    event.preventDefault()
    if (busy || !ready) return
    setBusy(true)
    setError('')
    try {
      const ctx = await context()
      if (!shift) {
        if (!validMoney(starting)) throw new Error('أدخل مبلغاً افتتاحياً صحيحاً غير سالب')
        const { error } = await supabase.from('shifts').insert({
          store_id: ctx.storeId, user_id: ctx.staffId, status: 'open',
          start_time: new Date().toISOString(),
          ...cashReconciliation(starting, starting),
          closed_at: null, end_time: null,
        })
        if (error) {
          console.error('[shift] open failed', error)
          throw error
        }
      } else {
        const end = new Date().toISOString()
        const [latestSales, latestExpenses] = await Promise.all([
          salesForShift(shift, ctx.storeId, end),
          expensesForShift(shift, ctx.storeId, end),
        ])
        const current = await readShift(ctx.storeId)
        if (!current || current.id !== shift.id) throw new Error('تغيرت الوردية. أعد فتح التقفيلة')
        const latestExpected = expectedCash({
          openingFloat: shift.expected_cash,
          cashSales: latestSales,
          creditPayments: current.total_credit_payments,
          collections: current.total_collections,
          employeePayments: current.total_employee_payments,
          expenses: latestExpenses,
        })
        // Every component must be unchanged since the count started; the server
        // recomputes the same figure and rejects a stale one.
        const moved = latestSales !== cashSales
          || latestExpenses !== drawerExpenses
          || Number(current.total_employee_payments || 0) !== Number(shift.total_employee_payments || 0)
          || Number(current.total_credit_payments || 0) !== Number(shift.total_credit_payments || 0)
          || Number(current.total_collections || 0) !== Number(shift.total_collections || 0)
        setShift(current)
        const amounts = cashReconciliation(actual, latestExpected)
        const latestDifference = amounts.difference
        setCashSales(latestSales); setDrawerExpenses(latestExpenses)
        if (!Number.isSafeInteger(actual)) throw new Error('المبلغ المعدود غير صالح')
        if (moved) throw new Error('تغيرت حركة الصندوق أثناء العد. راجع المبلغ المتوقع وأكد التقفيلة مجدداً.')
        if (latestDifference !== 0 && !notes.trim()) throw new Error('يجب توضيح سبب الفرق في الملاحظات')
        const { error } = await supabase.rpc('engine_close_shift', {
          p_shift: shift.id, p_actual: amounts.actual_cash, p_expected: amounts.expected_cash,
          p_difference: amounts.difference, p_notes: notes.trim() || null,
        })
        if (error) { console.error('[shift] close failed', error); throw error }
      }
      setModal(false)
      await refresh()
    } catch (err) { setError(err.message) }
    finally { setBusy(false) }
  }

  // Always render the control. It used to disappear behind a branch/online
  // condition in TopBar, and an error made the label so long it was clipped on
  // a phone. Short labels plus an explicit aria-label keep it reachable.
  const label = loading ? '...' : shift ? 'الصندوق مفتوح' : 'فتح الصندوق'
  const aria = loading ? 'جاري التحقق من الصندوق'
    : error && !modal ? 'تعذر التحقق من الصندوق، إعادة المحاولة'
    : shift ? 'الوردية مفتوحة، افتح التقفيلة' : 'فتح الوردية'
  return <>
    <button type="button" disabled={loading || busy} onClick={openModal} aria-label={aria} title={aria}
      className={`shrink-0 whitespace-nowrap rounded-lg px-2.5 py-1.5 text-[11px] font-medium disabled:opacity-50 ${shift ? 'bg-emerald-900 text-emerald-100' : 'bg-[#8B1E1E] text-red-100'}`}>
      <span className="hidden sm:inline">{label}</span>
      <span className="sm:hidden">{loading ? '...' : shift ? 'الصندوق' : 'فتح'}</span>
    </button>
    {modal && createPortal(<div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/80 p-4" dir="rtl">
      <form onSubmit={save} role="dialog" aria-modal="true" aria-labelledby="shift-title" className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-2xl border border-gold/30 bg-[#171717] p-5 text-neutral-100 shadow-2xl">
        <div className="mb-4 flex items-center justify-between">
          <h2 id="shift-title" className="font-medium text-gold">{shift ? 'إغلاق الوردية · التقفيلة' : 'فتح الوردية'}</h2>
          <button type="button" disabled={busy} onClick={() => setModal(false)} className="text-sm text-neutral-400">إغلاق</button>
        </div>
        {busy && !ready && <p className="mb-3 text-sm text-neutral-400">جاري التحقق من الصندوق...</p>}
        {ready && (shift ? <>
          <div className="mb-4 space-y-2 rounded-xl bg-black/20 p-3 text-sm">
            <p>الرصيد الافتتاحي: {formatDzd(shift.expected_cash)}</p>
            <p>المبيعات النقدية منذ فتح الوردية: {formatDzd(cashSales)}</p>
            {Number(shift.total_credit_payments || 0) > 0 && <p>دفعات كريدي نقدية: {formatDzd(shift.total_credit_payments)}</p>}
            {Number(shift.total_collections || 0) > 0 && <p>شيكات محصلة إلى الصندوق: {formatDzd(shift.total_collections)}</p>}
            <p>الرواتب والسلف المدفوعة: {formatDzd(shift.total_employee_payments || 0)}</p>
            {Number(drawerExpenses || 0) > 0 && <p>مصاريف مدفوعة من الصندوق: −{formatDzd(drawerExpenses)}</p>}
            <p className="text-gold">النقد المتوقع: {formatDzd(expected)}</p>
          </div>
          <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-3">
            {DENOMINATIONS.map(value => <label key={value} className="text-xs text-neutral-400">
              <span className="mb-1 block">{formatDzd(value)} · العدد</span>
              <input aria-label={`عدد أوراق ${value}`} type="number" min="0" step="1" disabled={busy} value={counts[value] ?? ''}
                onChange={e => { if (e.target.value === '' || validMoney(e.target.value)) setCounts(prev => ({ ...prev, [value]: e.target.value })) }} className={inputClass} />
            </label>)}
          </div>
          <p className="mb-2 text-gold">النقد الفعلي: {formatDzd(actual)}</p>
          <p className={`mb-4 ${difference ? 'text-red-300' : 'text-emerald-300'}`} aria-live="polite">الفرق (الفعلي − المتوقع): {formatDzd(difference)}</p>
          <label className="mb-4 block text-sm">ملاحظات {difference !== 0 && '(إلزامي عند وجود فرق)'}
            <textarea required={difference !== 0} disabled={busy} value={notes} onChange={e => setNotes(e.target.value)} className={`${inputClass} mt-2`} />
          </label>
        </> : <label className="mb-4 block text-sm">الرصيد الافتتاحي (دج)
          <input autoFocus required type="number" min="0" step="1" disabled={busy} value={starting} onChange={e => setStarting(e.target.value)} className={`${inputClass} mt-2`} />
        </label>)}
        {error && <p role="alert" className="mb-3 rounded-lg border border-red-800/50 bg-red-950/30 p-3 text-sm text-red-200">{error}</p>}
        <button disabled={busy || !ready} className="w-full rounded-lg bg-gold py-2.5 text-sm font-medium text-black disabled:opacity-50">{busy ? 'جاري الحفظ...' : shift ? 'تأكيد التقفيلة' : 'فتح الصندوق'}</button>
      </form>
    </div>, document.body)}
  </>
}
