'use client'

import { useEffect, useState } from 'react'
import { scopeQuery } from '@/lib/access'
import { fetchAllRows, validMoney } from '@/lib/cash'
import { supabase } from '@/lib/supabase'
import { formatDzd, getAppContext } from '@/lib/app-context'
import { CreditPaymentModal } from '@/components/dashboard/CreditLedger'
import LedgerModal from '@/components/dashboard/LedgerModal'
import CustomerPicker from '@/components/dashboard/CustomerPicker'
import { secondaryClass } from '@/components/dashboard/EngineUI'

function formatDate(value) {
  if (!value) return '—'
  return new Date(value).toLocaleDateString('ar-DZ')
}

function waLink(phone, name, amount) {
  const digits = String(phone || '').replace(/\D/g, '')
  if (!digits) return null
  const intl = digits.startsWith('0') ? `213${digits.slice(1)}` : digits.startsWith('213') ? digits : `213${digits}`
  const msg = encodeURIComponent(
    `السلام عليكم ${name || ''}، تذكير ودي بأن المبلغ المتبقي لديكم هو ${formatDzd(amount)}. شكراً لثقتكم في Vetrina.`
  )
  return `https://wa.me/${intl}?text=${msg}`
}

export default function CreditsPage() {
  const [credits, setCredits] = useState([])
  const [loading, setLoading] = useState(true)
  const [open, setOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  // Exactly one modal can be open: a payment form or a customer ledger.
  const [payCredit, setPayCredit] = useState(null)
  const [ledgerCustomer, setLedgerCustomer] = useState(null)
  const [ctx, setCtx] = useState({ tenantId: null, storeId: null })
  const [form, setForm] = useState({
    // `customer` is the picker's value: { id, name, phone }. Keeping the id lets
    // the RPC skip the name match entirely, which is where duplicates began.
    customer: { id: null, name: '', phone: '' },
    amount: '',
    description: '',
    due_date: '',
  })

  async function loadCredits() {
    setLoading(true)
    try {
      const context = await getAppContext()
      setCtx(context)
      let query = supabase
        .from('credits')
        .select('id, remaining_amount, total_amount, due_date, description, status, created_at, customers!inner(name, phone, tenant_id)')
        .eq('customers.tenant_id', context.tenantId).order('created_at', { ascending: false }).order('id')
      const data = await fetchAllRows(scopeQuery(query, context))
      setCredits(data || [])
    } catch (err) { setError(err.message) } finally { setLoading(false) }
  }

  useEffect(() => {
    loadCredits()
  }, [])

  async function handleSave(e) {
    e.preventDefault()
    if (saving) return
    setError('')
    try {
      if (!form.customer.name.trim() || !validMoney(form.amount) || Number(form.amount) <= 0) {
        setError('يرجى إدخال اسم الزبون والمبلغ')
        return
      }
      if (!ctx.tenantId || !ctx.storeId) {
        setError('لم يتم العثور على المتجر أو المؤسسة')
        return
      }

      setSaving(true)
      // Matching and insertion happen in one server-side transaction. Doing the
      // lookup in the browser means two tills can both miss each other and
      // create the same customer; `customers_tenant_match_key` now makes that
      // impossible, and the function retries the read instead of erroring.
      const { data: result, error: rpcError } = await supabase.rpc('engine_create_credit', {
        p_store: ctx.storeId,
        p_name: form.customer.name,
        p_phone: form.customer.phone,
        // The chosen row wins; the server matches by phone/name only when null.
        p_customer_id: form.customer.id,
        p_amount: Number(form.amount),
        p_description: form.description,
        p_due_date: form.due_date || null,
      })
      if (rpcError) { setSaving(false); setError(rpcError.message); return }

      // Surface the match so the cashier sees the debt went to an existing
      // customer rather than silently creating a near-duplicate.
      setNotice(result?.createdCustomer
        ? `تم إنشاء زبون جديد: ${result.customerName}`
        : `تم ربط الدين بالزبون الموجود: ${result?.customerName || ''}`)

      setOpen(false)
      setForm({ customer: { id: null, name: '', phone: '' }, amount: '', description: '', due_date: '' })
      loadCredits()
    } catch (err) { setError(err.message) } finally { setSaving(false) }
  }

  return (
    <>
      <div className="mb-3 flex items-center justify-between gap-2">
        <h1 className="text-base font-medium text-neutral-100">الكريدي</h1>
        <button
          type="button"
          onClick={() => { setOpen(true); setNotice(''); setError('') }}
          className="rounded-lg bg-gold px-3 py-2 text-sm font-medium text-[#121212]"
        >
          إضافة كريدي
        </button>
      </div>

      {!open && error && <p role="alert" className="mb-3 text-sm text-red-300">{error}</p>}
      {!open && notice && <p role="status" className="mb-3 text-sm text-emerald-300">{notice}</p>}
      {loading ? (
        <p className="text-sm text-neutral-500">جاري التحميل...</p>
      ) : credits.length === 0 ? (
        <div className="rounded-xl border border-dashed border-white/10 bg-card p-8 text-center">
          <p className="text-sm text-neutral-300">لا توجد ديون مسجلة</p>
        </div>
      ) : (
        <div className="space-y-2">
          {credits.map((credit) => {
            const name = credit.customers?.name || 'زبون'
            const phone = credit.customers?.phone
            const amount = credit.remaining_amount ?? credit.total_amount
            const wa = waLink(phone, name, amount)
            return (
              <article key={credit.id} className="rounded-xl border border-white/5 bg-card p-3">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <button type="button" onClick={() => setLedgerCustomer(credit.customers?.id)}
                      className="text-right text-sm font-medium text-neutral-100 underline decoration-dotted underline-offset-4 hover:text-gold">
                      {name}
                    </button>
                    <p className="text-[11px] text-neutral-500">{phone || 'بدون رقم'}</p>
                  </div>
                  <span className="text-sm font-bold text-gold">{formatDzd(amount)}</span>
                </div>
                <p className="mt-1 text-[11px] text-neutral-500">الاستحقاق: {formatDate(credit.due_date)}</p>
                {credit.description && (
                  <p className="mt-1 text-xs text-neutral-400">{credit.description}</p>
                )}
                <div className="mt-2 flex flex-wrap gap-2">
                  {Number(credit.remaining_amount ?? credit.total_amount) > 0 && credit.status !== 'paid' && (
                    <button type="button" onClick={() => setPayCredit(credit)} className={secondaryClass}>
                      تسجيل دفعة
                    </button>
                  )}
                  {wa && (
                    <a
                      href={wa}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex rounded-lg border border-gold/30 px-2.5 py-1.5 text-[11px] text-gold"
                    >
                      تذكير واتساب
                    </a>
                  )}
                </div>
              </article>
            )
          })}
        </div>
      )}

      {open && (
        <div className="fixed inset-0 z-50 bg-black/70 flex items-end md:items-center justify-center p-0 md:p-4">
          <form
            onSubmit={handleSave}
            className="w-full max-w-md rounded-t-2xl md:rounded-2xl bg-[#171717] border border-white/10 p-4"
          >
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-sm font-medium">إضافة كريدي</h2>
              <button type="button" onClick={() => setOpen(false)} className="text-xs text-neutral-400">
                إغلاق
              </button>
            </div>
            <div className="space-y-3">
              <div className="block">
                <span className="mb-1 block text-xs text-neutral-400">الزبون</span>
                <CustomerPicker
                  tenantId={ctx.tenantId}
                  value={form.customer}
                  onChange={(customer) => setForm({ ...form, customer })}
                />
              </div>
              <label className="block">
                <span className="mb-1 block text-xs text-neutral-400">المبلغ</span>
                <input
                  type="number"
                  min="0"
                  value={form.amount}
                  onChange={(e) => setForm({ ...form, amount: e.target.value })}
                  className="w-full rounded-lg border border-neutral-700 bg-[#141414] px-3 py-2 text-sm outline-none focus:border-gold"
                  required
                />
              </label>
              <label className="block">
                <span className="mb-1 block text-xs text-neutral-400">الوصف</span>
                <input
                  value={form.description}
                  onChange={(e) => setForm({ ...form, description: e.target.value })}
                  className="w-full rounded-lg border border-neutral-700 bg-[#141414] px-3 py-2 text-sm outline-none focus:border-gold"
                />
              </label>
              <label className="block">
                <span className="mb-1 block text-xs text-neutral-400">تاريخ الاستحقاق</span>
                <input
                  type="date"
                  value={form.due_date}
                  onChange={(e) => setForm({ ...form, due_date: e.target.value })}
                  className="w-full rounded-lg border border-neutral-700 bg-[#141414] px-3 py-2 text-sm outline-none focus:border-gold"
                />
              </label>
            </div>
            {error && <p className="mt-3 text-xs text-red-300">{error}</p>}
            <button
              type="submit"
              disabled={saving}
              className="mt-4 w-full rounded-lg bg-gold py-2.5 text-sm font-medium text-[#121212] disabled:opacity-60"
            >
              {saving ? 'جاري الحفظ...' : 'حفظ'}
            </button>
          </form>
        </div>
      )}

      {payCredit && <CreditPaymentModal
        credit={payCredit}
        onClose={() => setPayCredit(null)}
        onSaved={() => { loadCredits() }}
      />}

      {/* One ledger component for every entry point, so the columns cannot
          drift between the credits screen and the customers screen. */}
      {ledgerCustomer && <LedgerModal kind="customer" id={ledgerCustomer}
        onClose={() => { setLedgerCustomer(null); loadCredits() }} />}
    </>
  )
}
