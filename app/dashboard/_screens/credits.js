'use client'

import { useEffect, useState } from 'react'
import { scopeQuery } from '@/lib/access'
import { fetchAllRows, validMoney } from '@/lib/cash'
import { supabase } from '@/lib/supabase'
import { formatDzd, getAppContext } from '@/lib/app-context'
import { CreditPaymentModal, CustomerLedgerModal } from '@/components/dashboard/CreditLedger'
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
  // Exactly one modal can be open: a payment form or a customer ledger.
  const [payCredit, setPayCredit] = useState(null)
  const [ledgerCustomer, setLedgerCustomer] = useState(null)
  const [ctx, setCtx] = useState({ tenantId: null, storeId: null })
  const [form, setForm] = useState({
    name: '',
    phone: '',
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
      if (!form.name.trim() || !validMoney(form.amount) || Number(form.amount) <= 0) {
        setError('يرجى إدخال اسم الزبون والمبلغ')
        return
      }
      if (!ctx.tenantId || !ctx.storeId) {
        setError('لم يتم العثور على المتجر أو المؤسسة')
        return
      }

      setSaving(true)
      // Customers are tenant-wide, not per store. Matching used to be routed
      // through an inner join on that store's credits, so a customer whose only
      // debt was in another branch never matched and was duplicated on every
      // new credit. Match on the tenant alone.
      let customer = null
      const name = form.name.trim()
      const phone = form.phone.trim()

      if (phone) {
        const { data, error: phoneError } = await supabase
          .from('customers')
          .select('id, name, phone')
          .eq('tenant_id', ctx.tenantId)
          .eq('phone', phone)
          .order('id')
          .limit(1)
        if (phoneError) throw phoneError
        customer = data?.[0] || null
      }
      if (!customer) {
        const { data, error: nameError } = await supabase
          .from('customers')
          .select('id, name, phone')
          .eq('tenant_id', ctx.tenantId)
          .eq('name', name)
          .order('id')
          .limit(1)
        if (nameError) throw nameError
        customer = data?.[0] || null
      }
      if (!customer) {
        const { data: created, error: insertError } = await supabase
          .from('customers')
          .insert({ tenant_id: ctx.tenantId, name, phone: phone || null })
          .select('id, name, phone')
          .single()
        if (insertError || !created) {
          setSaving(false)
          setError(insertError?.message || 'فشل حفظ الزبون')
          return
        }
        customer = created
      }

      const amount = Number(form.amount)
      const { error: crErr } = await supabase.from('credits').insert({
        store_id: ctx.storeId,
        created_by: ctx.staffId,
        customer_id: customer.id,
        total_amount: amount,
        remaining_amount: amount,
        description: form.description.trim() || null,
        due_date: form.due_date || null,
        status: 'active',
      })

      setSaving(false)
      if (crErr) {
        setError(crErr.message)
        return
      }

      setOpen(false)
      setForm({ name: '', phone: '', amount: '', description: '', due_date: '' })
      loadCredits()
    } catch (err) { setError(err.message) } finally { setSaving(false) }
  }

  return (
    <>
      <div className="mb-3 flex items-center justify-between gap-2">
        <h1 className="text-base font-medium text-neutral-100">الكريدي</h1>
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="rounded-lg bg-gold px-3 py-2 text-sm font-medium text-[#121212]"
        >
          إضافة كريدي
        </button>
      </div>

      {!open && error && <p role="alert" className="mb-3 text-sm text-red-300">{error}</p>}
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
              <label className="block">
                <span className="mb-1 block text-xs text-neutral-400">اسم الزبون</span>
                <input
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                  className="w-full rounded-lg border border-neutral-700 bg-[#141414] px-3 py-2 text-sm outline-none focus:border-gold"
                  required
                />
              </label>
              <label className="block">
                <span className="mb-1 block text-xs text-neutral-400">الهاتف (اختياري)</span>
                <input
                  value={form.phone}
                  onChange={(e) => setForm({ ...form, phone: e.target.value })}
                  className="w-full rounded-lg border border-neutral-700 bg-[#141414] px-3 py-2 text-sm outline-none focus:border-gold"
                />
              </label>
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

      {ledgerCustomer && <CustomerLedgerModal
        customerId={ledgerCustomer}
        onClose={() => setLedgerCustomer(null)}
      />}
    </>
  )
}
