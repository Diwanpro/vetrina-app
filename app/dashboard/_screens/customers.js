'use client'

import { useEffect, useMemo, useState } from 'react'
import { supabase } from '@/lib/supabase'
import { fetchAllRows } from '@/lib/cash'
import { formatDzd, getAppContext } from '@/lib/app-context'
import LedgerModal from '@/components/dashboard/LedgerModal'

// Customers are owned per tenant, not per store, so this list is tenant-scoped
// even when the owner is looking at a single branch.
export default function CustomersPage() {
  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [search, setSearch] = useState('')
  const [ledger, setLedger] = useState(null)

  useEffect(() => {
    let cancelled = false
    async function load() {
      setLoading(true); setError('')
      try {
        const ctx = await getAppContext()
        if (!ctx?.tenantId) throw new Error('تعذر تحديد المتجر')
        const data = await fetchAllRows(
          supabase.from('customers')
            .select('id, name, phone, created_at, credits(remaining_amount, status)')
            .eq('tenant_id', ctx.tenantId)
            .order('name').order('id')
        )
        if (!cancelled) setRows(data || [])
      } catch (err) { if (!cancelled) setError(err.message) }
      finally { if (!cancelled) setLoading(false) }
    }
    load()
    window.addEventListener('vetrina:credit-payment', load)
    return () => { cancelled = true; window.removeEventListener('vetrina:credit-payment', load) }
  }, [])

  const customers = useMemo(() => rows.map(row => {
    const debts = (row.credits || []).filter(c => c.status !== 'paid')
    const owed = debts.reduce((sum, c) => sum + Number(c.remaining_amount || 0), 0)
    return { ...row, owed, openDebts: debts.length }
  }), [rows])

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase()
    if (!term) return customers
    return customers.filter(c =>
      String(c.name || '').toLowerCase().includes(term) || String(c.phone || '').includes(term))
  }, [customers, search])

  const totalOwed = customers.reduce((sum, c) => sum + c.owed, 0)

  return <>
    <div className="mb-3 flex flex-wrap items-end justify-between gap-2">
      <div>
        <h1 className="text-base font-medium text-neutral-100">الزبائن</h1>
        <p className="mt-1 text-xs text-neutral-500">{customers.length} زبون · إجمالي المستحق {formatDzd(totalOwed)}</p>
      </div>
      <input value={search} onChange={e => setSearch(e.target.value)} placeholder="بحث بالاسم أو الهاتف"
        className="w-full rounded-lg border border-[#D4AF37]/40 bg-[#1A1A1A] px-3 py-2 text-sm text-white outline-none focus:border-gold sm:w-64" />
    </div>

    {error && <p role="alert" className="mb-3 text-sm text-red-300">{error}</p>}
    {loading ? <p className="text-sm text-neutral-500">جاري التحميل...</p>
      : !filtered.length ? (
        <div className="rounded-xl border border-dashed border-white/10 bg-card p-8 text-center">
          <p className="text-sm text-neutral-300">{search ? 'لا نتائج مطابقة' : 'لا يوجد زبائن بعد'}</p>
        </div>
      ) : (
        <div className="space-y-2">
          {filtered.map(customer => <article key={customer.id} className="rounded-xl border border-white/5 bg-card p-3">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div className="min-w-0">
                <button type="button" onClick={() => setLedger(customer)}
                  className="text-right text-sm font-medium text-neutral-100 underline decoration-dotted underline-offset-4 hover:text-gold">
                  {customer.name}
                </button>
                <p dir="ltr" className="text-[11px] text-neutral-500">{customer.phone || 'بدون رقم'}</p>
              </div>
              <span className={`text-sm font-bold ${customer.owed > 0 ? 'text-gold' : 'text-emerald-300'}`}>
                {formatDzd(customer.owed)}
              </span>
            </div>
            {customer.openDebts > 0 && <p className="mt-1 text-[11px] text-neutral-500">{customer.openDebts} دين مفتوح</p>}
          </article>)}
        </div>
      )}

    {ledger && <LedgerModal kind="customer" id={ledger.id} onClose={() => setLedger(null)} />}
  </>
}
