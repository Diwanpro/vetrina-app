'use client'

import { useCallback, useEffect, useState } from 'react'
import { useDashboardSession } from '@/components/dashboard/SessionProvider'
import { Modal, Notice, fieldClass, primaryClass, secondaryClass } from '@/components/dashboard/EngineUI'
import { supabase } from '@/lib/supabase'
import { formatDzd } from '@/lib/app-context'
import { fetchAllRows } from '@/lib/cash'

const BUCKET = 'receipts'
const MAX_BYTES = 5 * 1024 * 1024
const CATEGORIES = ['إيجار', 'كهرباء وماء', 'رواتب إضافية', 'نقل', 'تسويق', 'صيانة', 'قرطاسية', 'أخرى']

function newRequestId() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID()
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`
}

function formatDate(value) {
  return value ? new Date(value).toLocaleDateString('ar-DZ') : '—'
}

export default function ExpensesPage() {
  const ctx = useDashboardSession()
  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [adding, setAdding] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(null)
  const [form, setForm] = useState({ amount: '', category: CATEGORIES[0], description: '' })
  const [file, setFile] = useState(null)
  const [requestId, setRequestId] = useState(newRequestId)

  const canDelete = ['owner', 'manager'].includes(ctx.role)

  const load = useCallback(async () => {
    if (!ctx?.tenantId) return
    setLoading(true); setError('')
    try {
      // Scoping mirrors the rest of the app: owners see the whole tenant, staff
      // see the branch they are assigned to.
      let query = supabase.from('expenses')
        .select('id, amount, description, category, receipt_url, created_at, created_by, deleted_at, store_id, stores!inner(name, tenant_id)')
        .eq('stores.tenant_id', ctx.tenantId)
        .is('deleted_at', null)
        .order('created_at', { ascending: false })
      if (ctx.role !== 'owner') query = query.eq('store_id', ctx.storeId)
      const data = await fetchAllRows(query)
      setRows(data || [])
    } catch (err) { setError(err.message) } finally { setLoading(false) }
  }, [ctx?.tenantId, ctx?.role, ctx?.storeId])

  useEffect(() => { load() }, [load])

  function resetForm() {
    setForm({ amount: '', category: CATEGORIES[0], description: '' })
    setFile(null)
    setRequestId(newRequestId())
  }

  async function submit(event) {
    event.preventDefault()
    const amount = Number(String(form.amount).replace(/[^0-9]/g, ''))
    if (!amount || amount <= 0) { setError('أدخل مبلغاً موجباً'); return }
    if (!form.description.trim()) { setError('أدخل وصفاً للمصروف'); return }
    if (!ctx.storeId) { setError('لا يوجد فرع محدد لتسجيل المصروف'); return }
    setBusy(true); setError('')
    try {
      let receiptPath = null
      if (file) {
        if (file.size > MAX_BYTES) throw new Error('حجم الصورة أكبر من 5 ميغابايت')
        if (!/^image\/(jpeg|png|webp)$|^application\/pdf$/.test(file.type)) {
          throw new Error('الصيغة يجب أن تكون JPG أو PNG أو WebP أو PDF')
        }
        const extension = (file.name.split('.').pop() || 'jpg').toLowerCase().replace(/[^a-z0-9]/g, '')
        // Path is <tenant>/<store>/<file> so storage policies can scope it.
        const path = `${ctx.tenantId}/${ctx.storeId}/${Date.now()}-${newRequestId()}.${extension}`
        const { error: uploadError } = await supabase.storage.from(BUCKET).upload(path, file, { upsert: false, contentType: file.type })
        if (uploadError) throw new Error(`تعذر رفع الإيصال: ${uploadError.message}`)
        receiptPath = path
      }

      const { error: rpcError } = await supabase.rpc('engine_record_expense_v2', {
        p_store: ctx.storeId,
        p_amount: amount,
        p_description: form.description.trim(),
        p_category: form.category || null,
        p_receipt: receiptPath,
        p_request: requestId,
      })
      if (rpcError) throw rpcError

      window.dispatchEvent(new Event('vetrina:finance'))
      setAdding(false); resetForm(); setNotice('تم تسجيل المصروف')
      await load()
    } catch (err) { setError(err.message) } finally { setBusy(false) }
  }

  async function remove(row) {
    setBusy(true); setError('')
    try {
      const { error } = await supabase.rpc('engine_delete_expense', { p_expense: row.id })
      if (error) throw error
      window.dispatchEvent(new Event('vetrina:finance'))
      setConfirmDelete(null); setNotice('تم حذف المصروف')
      await load()
    } catch (err) { setError(err.message) } finally { setBusy(false) }
  }

  async function openReceipt(path) {
    setError('')
    try {
      const { data, error } = await supabase.storage.from(BUCKET).createSignedUrl(path, 60)
      if (error) throw error
      window.open(data.signedUrl, '_blank', 'noopener,noreferrer')
    } catch (err) { setError(err.message) }
  }

  return <>
    <div className="mx-auto max-w-5xl space-y-5">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl text-gold">المصاريف</h1>
          <p className="mt-2 text-xs text-neutral-500">سجل المصاريف مع الإيصالات · الحذف متاح للمالك والمدير</p>
        </div>
        <button className={primaryClass} onClick={() => { setError(''); setNotice(''); resetForm(); setAdding(true) }}>إضافة مصروف</button>
      </header>

      <Notice error={error} success={notice} />

      <section className="rounded-2xl border border-white/10 bg-card p-5">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-gold">قائمة المصاريف · {rows.length}</h2>
          <button disabled={loading || busy} className={secondaryClass} onClick={load}>تحديث</button>
        </div>
        {loading ? <p className="text-neutral-400">جاري التحميل...</p> : !rows.length ? (
          <p className="rounded-xl border border-dashed border-white/10 p-8 text-center text-sm text-neutral-400">لا توجد مصاريف مسجلة.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[680px] text-right text-sm">
              <thead><tr className="text-neutral-500">{['التاريخ', 'التصنيف', 'الوصف', 'المبلغ', 'الإيصال', ''].map(h => <th key={h} className="p-3 font-normal">{h}</th>)}</tr></thead>
              <tbody>
                {rows.map(row => <tr key={row.id} className="border-t border-white/5 text-neutral-300">
                  <td className="whitespace-nowrap p-3">{formatDate(row.created_at)}</td>
                  <td className="p-3">{row.category || '—'}</td>
                  <td className="max-w-sm break-words p-3">{row.description}</td>
                  <td className="whitespace-nowrap p-3 text-gold">{formatDzd(row.amount)}</td>
                  <td className="p-3">{row.receipt_url
                    ? <button className="text-gold underline" onClick={() => openReceipt(row.receipt_url)}>عرض</button>
                    : <span className="text-neutral-600">—</span>}</td>
                  <td className="p-3">{canDelete
                    ? <button disabled={busy} className="text-xs text-red-300 underline hover:text-red-200" onClick={() => setConfirmDelete(row)}>حذف</button>
                    : <span className="text-xs text-neutral-600">—</span>}</td>
                </tr>)}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>

    {adding && <Modal title="إضافة مصروف" onClose={() => setAdding(false)} busy={busy}>
      <form onSubmit={submit} className="space-y-4">
        <label className="block text-sm text-neutral-300">المبلغ
          <input inputMode="numeric" required autoFocus disabled={busy} value={form.amount}
            onChange={e => setForm({ ...form, amount: e.target.value.replace(/[^0-9]/g, '') })}
            className={`${fieldClass} mt-1`} placeholder="0" />
        </label>
        <label className="block text-sm text-neutral-300">التصنيف
          <select disabled={busy} value={form.category} onChange={e => setForm({ ...form, category: e.target.value })} className={`${fieldClass} mt-1`}>
            {CATEGORIES.map(category => <option key={category} value={category}>{category}</option>)}
          </select>
        </label>
        <label className="block text-sm text-neutral-300">الوصف
          <textarea required disabled={busy} rows={3} maxLength={1000} value={form.description}
            onChange={e => setForm({ ...form, description: e.target.value })}
            className={`${fieldClass} mt-1`} />
        </label>
        <label className="block text-sm text-neutral-300">صورة الإيصال (اختياري)
          <input type="file" accept="image/jpeg,image/png,image/webp,application/pdf" disabled={busy}
            onChange={e => setFile(e.target.files?.[0] || null)} className={`${fieldClass} mt-1`} />
          <span className="mt-1 block text-[11px] text-neutral-500">JPG أو PNG أو WebP أو PDF · حتى 5 ميغابايت</span>
        </label>
        <button disabled={busy} className={primaryClass}>{busy ? 'جاري الحفظ...' : 'حفظ المصروف'}</button>
      </form>
    </Modal>}

    {confirmDelete && <Modal title="تأكيد حذف المصروف" onClose={() => setConfirmDelete(null)} busy={busy}>
      <p className="mb-2 text-sm text-neutral-300">{confirmDelete.description}</p>
      <p className="mb-4 text-lg text-gold">{formatDzd(confirmDelete.amount)}</p>
      <p className="mb-4 rounded-lg border border-amber-700/30 bg-amber-950/20 p-3 text-xs text-amber-200">
        يُخفى المصروف من القوائم ومن حساب صافي الربح، لكنه يبقى محفوظاً في قاعدة البيانات لسلامة التقارير.
      </p>
      <div className="flex gap-3">
        <button disabled={busy} className="rounded-lg bg-red-900/60 px-4 py-2 text-sm text-red-100" onClick={() => remove(confirmDelete)}>تأكيد الحذف</button>
        <button disabled={busy} className={secondaryClass} onClick={() => setConfirmDelete(null)}>إلغاء</button>
      </div>
    </Modal>}
  </>
}
