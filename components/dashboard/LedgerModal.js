'use client'

import { useCallback, useEffect, useState } from 'react'
import { Modal, Notice, primaryClass, secondaryClass } from '@/components/dashboard/EngineUI'
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

// One modal for both ledgers: the two RPCs return the same entry shape, so the
// table is written once and cannot drift between customers and suppliers.
export default function LedgerModal({ kind, id, onClose, onPay }) {
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

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

  return <Modal title={`سجل ${kind === 'supplier' ? 'المورد' : 'الزبون'} · ${party?.name || ''}`} onClose={onClose} wide>
    <Notice error={error} />

    <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
      <div className="flex flex-wrap gap-3">
        {[['إجمالي الدين', total, 'text-neutral-100'],
          ['المدفوع نقداً', cash, 'text-emerald-300'],
          ['شيك / CCP', paper, 'text-sky-300'],
          ['المتبقي', data?.remaining, Number(data?.remaining) > 0 ? 'text-red-300' : 'text-emerald-300']]
          .map(([label, value, tone]) => <section key={label} className="rounded-xl border border-white/10 bg-black/20 px-3 py-2">
            <h3 className="text-[11px] text-neutral-500">{label}</h3>
            <p className={`mt-1 text-sm ${tone}`}>{formatDzd(value)}</p>
          </section>)}
      </div>
      {onPay && <button type="button" onClick={() => onPay(party)} className={primaryClass}>تسجيل دفعة</button>}
    </div>

    {party?.phone && <p className="mb-3 text-sm text-neutral-400">الهاتف: <span dir="ltr">{party.phone}</span></p>}

    {loading ? <p className="text-sm text-neutral-400">جاري التحميل...</p>
      : !entries.length ? <p className="text-sm text-neutral-500">لا توجد حركات مسجلة بعد.</p>
      : <div className="overflow-x-auto">
        <table className="w-full min-w-[720px] text-right text-xs">
          <thead>
            <tr className="text-neutral-500">
              {['التاريخ', 'البيان', 'الإجمالي', 'المدفوع نقداً', 'شيك / CCP', 'المتبقي'].map(h =>
                <th key={h} className="whitespace-nowrap p-2 font-normal">{h}</th>)}
            </tr>
          </thead>
          {/* Oldest to newest, so the running balance reads top to bottom. */}
          <tbody>
            {entries.map((row, index) => <tr key={`${row.date}-${row.kind}-${index}`} className="border-t border-white/5">
              <td className="whitespace-nowrap p-2 text-neutral-400">{day(row.date)}</td>
              <td className="p-2">
                <span className={KINDS[row.kind] || 'text-neutral-300'}>{row.label}</span>
                {row.detail && <span className="block truncate text-[11px] text-neutral-500">{row.detail}</span>}
              </td>
              <td className="whitespace-nowrap p-2 text-neutral-200">{row.total ? formatDzd(row.total) : '—'}</td>
              <td className="whitespace-nowrap p-2 text-emerald-300">{row.cash ? formatDzd(row.cash) : '—'}</td>
              <td className="whitespace-nowrap p-2 text-sky-300">{row.paper ? formatDzd(row.paper) : '—'}</td>
              <td className={`whitespace-nowrap p-2 font-medium ${Number(row.remaining) > 0 ? 'text-gold' : 'text-emerald-300'}`}>
                {formatDzd(row.remaining)}
              </td>
            </tr>)}
          </tbody>
        </table>
      </div>}

    <div className="mt-4 flex justify-end">
      <button type="button" onClick={onClose} className={secondaryClass}>إغلاق</button>
    </div>
  </Modal>
}
