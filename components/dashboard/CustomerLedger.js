'use client'

import { useCallback, useEffect, useState } from 'react'
import { Modal, Notice, secondaryClass } from '@/components/dashboard/EngineUI'
import { supabase } from '@/lib/supabase'
import { fetchAllRows } from '@/lib/cash'
import { formatDzd } from '@/lib/app-context'

// Read-only view of one customer's open debts. Settling a debt stays in the
// credit ledger, where the cash-in-drawer rules are already enforced.
export default function CustomerLedger({ customer, onClose }) {
  const [credits, setCredits] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    setLoading(true); setError('')
    try {
      const data = await fetchAllRows(
        supabase.from('credits')
          .select('id, total_amount, remaining_amount, status, created_at, due_date, description')
          .eq('customer_id', customer.id)
          .order('created_at', { ascending: false }).order('id')
      )
      setCredits(data || [])
    } catch (err) { setError(err.message) } finally { setLoading(false) }
  }, [customer.id])

  useEffect(() => { load() }, [load])

  const open = credits.filter(c => c.status !== 'paid' && Number(c.remaining_amount || 0) > 0)
  const owed = open.reduce((sum, c) => sum + Number(c.remaining_amount || 0), 0)
  const settled = credits.reduce((sum, c) => sum + (Number(c.total_amount || 0) - Number(c.remaining_amount || 0)), 0)

  return <Modal title={`حساب الزبون · ${customer.name}`} onClose={onClose} wide>
    <Notice error={error} />
    <div className="mb-4 grid gap-3 sm:grid-cols-3">
      {[['إجمالي الديون', credits.reduce((s, c) => s + Number(c.total_amount || 0), 0), 'text-neutral-100'],
        ['المسدد', settled, 'text-emerald-300'],
        ['المتبقي', owed, owed > 0 ? 'text-red-300' : 'text-emerald-300']].map(([label, value, tone]) =>
        <section key={label} className="rounded-xl border border-white/10 bg-black/20 p-3">
          <h3 className="text-xs text-neutral-500">{label}</h3>
          <p className={`mt-1 text-base ${tone}`}>{formatDzd(value)}</p>
        </section>)}
    </div>
    {customer.phone && <p className="mb-3 text-sm text-neutral-400">الهاتف: <span dir="ltr">{customer.phone}</span></p>}

    {loading ? <p className="text-sm text-neutral-400">جاري التحميل...</p>
      : !credits.length ? <p className="text-sm text-neutral-500">لا يوجد سجل ديون لهذا الزبون.</p>
      : <div className="overflow-x-auto">
        <table className="w-full min-w-[520px] text-right text-sm">
          <thead><tr className="text-neutral-500">{['التاريخ', 'الإجمالي', 'المتبقي', 'الحالة'].map(h => <th key={h} className="p-2 font-normal">{h}</th>)}</tr></thead>
          <tbody>{credits.map(row => <tr key={row.id} className="border-t border-white/5 text-neutral-300">
            <td className="whitespace-nowrap p-2">{new Date(row.created_at).toLocaleDateString('ar-DZ')}</td>
            <td className="p-2">{formatDzd(row.total_amount)}</td>
            <td className={`p-2 ${Number(row.remaining_amount) > 0 ? 'text-gold' : 'text-emerald-300'}`}>{formatDzd(row.remaining_amount)}</td>
            <td className="p-2 text-xs text-neutral-400">{row.status === 'paid' ? 'مسدد' : row.status === 'active' ? 'نشط' : row.status}</td>
          </tr>)}</tbody>
        </table>
      </div>}
    <div className="mt-4"><button type="button" onClick={onClose} className={secondaryClass}>إغلاق</button></div>
  </Modal>
}
