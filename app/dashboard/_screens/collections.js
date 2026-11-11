'use client'

import { useCallback, useEffect, useState } from 'react'
import { useDashboardSession } from '@/components/dashboard/SessionProvider'
import { Modal, Notice, primaryClass, secondaryClass } from '@/components/dashboard/EngineUI'
import { supabase } from '@/lib/supabase'
import { formatDzd } from '@/lib/app-context'

const BUCKET = 'receipts'
const METHODS = { check: 'شيك', ccp: 'بريدي' }

function formatDate(value) {
  return value ? new Date(value).toLocaleDateString('ar-DZ') : '—'
}

export default function CollectionsPage() {
  const ctx = useDashboardSession()
  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [clearing, setClearing] = useState(null)
  const [destination, setDestination] = useState('cash')

  const load = useCallback(async () => {
    if (!ctx?.storeId && !ctx?.allBranches) return
    setLoading(true); setError('')
    try {
      const { data, error } = await supabase.rpc('engine_pending_collections', {
        p_store: ctx.allBranches ? null : ctx.storeId,
      })
      if (error) throw error
      setRows(Array.isArray(data) ? data : [])
    } catch (err) { setError(err.message) } finally { setLoading(false) }
  }, [ctx?.storeId, ctx?.allBranches])

  useEffect(() => { load() }, [load])

  async function openReceipt(path) {
    setError('')
    try {
      const { data, error } = await supabase.storage.from(BUCKET).createSignedUrl(path, 60)
      if (error) throw error
      window.open(data.signedUrl, '_blank', 'noopener,noreferrer')
    } catch (err) { setError(err.message) }
  }

  async function clear(row) {
    setBusy(true); setError(''); setNotice('')
    try {
      const { error } = await supabase.rpc('engine_clear_pending_collection', {
        p_id: row.id, p_destination: destination,
      })
      if (error) throw error
      setClearing(null)
      setNotice(destination === 'cash' ? 'تم التحصيل وإضافة المبلغ إلى الصندوق' : 'تم التحصيل وتسجيله كإيداع بنكي')
      // The drawer changed, so anything showing cash must refresh.
      window.dispatchEvent(new Event('vetrina:finance'))
      await load()
    } catch (err) { setError(err.message) } finally { setBusy(false) }
  }

  const total = rows.reduce((sum, row) => sum + Number(row.amount || 0), 0)

  return <>
    <div className="mx-auto max-w-5xl space-y-5">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-base font-medium text-neutral-100">التحصيلات</h1>
          <p className="mt-1 text-xs text-neutral-500">شيكات ووصولات بريدية لم تُحصَّل بعد. المبلغ لا يدخل الصندوق قبل التحصيل.</p>
        </div>
        <button type="button" disabled={loading} onClick={load} className={secondaryClass}>تحديث</button>
      </header>

      <Notice error={error} success={notice} />

      <section className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-gold/20 bg-card p-4">
        <div><h2 className="text-xs text-neutral-400">قيد التحصيل</h2><p className="mt-1 text-lg text-gold">{formatDzd(total)}</p></div>
        <div className="text-xs text-neutral-500">{rows.length} وصل</div>
      </section>

      {loading ? <p className="text-sm text-neutral-400">جاري التحميل...</p>
        : !rows.length ? <p className="text-sm text-neutral-500">لا توجد شيكات أو وصولات قيد التحصيل.</p>
        : <div className="space-y-3">
          {rows.map(row => <article key={row.id} className="rounded-2xl border border-white/5 bg-card p-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <h2 className="font-medium text-neutral-100">{row.customerName || 'بدون اسم'}</h2>
                <p className="mt-1 text-xs text-neutral-500">{formatDate(row.createdAt)} · {METHODS[row.method] || row.method}</p>
              </div>
              <p className="text-lg text-gold">{formatDzd(row.amount)}</p>
            </div>
            <div className="mt-3 flex flex-wrap gap-2">
              {row.receipt && <button type="button" onClick={() => openReceipt(row.receipt)}
                className="rounded-lg border border-white/10 px-3 py-1.5 text-xs text-neutral-300">عرض الوصل</button>}
              {/* Cheques cannot be banked on this screen without a destination choice. */}
              <button type="button" disabled={busy} onClick={() => { setClearing(row); setDestination('cash'); setError(''); setNotice('') }}
                className={primaryClass}>تم التحصيل</button>
            </div>
          </article>)}
        </div>}
    </div>

    {clearing && <Modal title="أين تريد إيداع المبلغ؟" busy={busy} onClose={() => setClearing(null)}>
      <Notice error={error} />
      <p className="mb-4 text-sm text-neutral-300">
        {clearing.customerName || 'بدون اسم'} · <span className="text-gold">{formatDzd(clearing.amount)}</span> · {METHODS[clearing.method] || clearing.method}
      </p>
      <div className="mb-4 space-y-2">
        {[['cash', 'الصندوق (Cash)', 'يُضاف إلى النقد المتوقع في الوردية المفتوحة.'],
          ['bank', 'البنك (Bank)', 'يُسجَّل كإيداع بنكي فقط، دون المساس بالصندوق.']].map(([value, label, hint]) =>
          <label key={value} className={`flex cursor-pointer gap-3 rounded-xl border p-3 ${destination === value ? 'border-gold/60 bg-gold/5' : 'border-white/10'}`}>
            <input type="radio" name="destination" value={value} checked={destination === value}
              disabled={busy} onChange={() => setDestination(value)} className="mt-1 accent-[#D4AF37]" />
            <span>
              <span className="block text-sm text-neutral-100">{label}</span>
              <span className="mt-0.5 block text-xs text-neutral-500">{hint}</span>
            </span>
          </label>)}
      </div>
      <p className="mb-4 rounded border border-white/10 bg-black/20 p-2 text-[11px] leading-5 text-neutral-400">
        لا يُحتسب هذا المبلغ كإيراد جديد؛ الفاتورة سُجّلت عند البيع. التحصيل حركة نقدية فقط.
      </p>
      <div className="flex flex-wrap gap-2">
        <button type="button" disabled={busy} onClick={() => clear(clearing)} className={primaryClass}>
          {busy ? 'جاري التحصيل...' : 'تأكيد التحصيل'}
        </button>
        <button type="button" disabled={busy} onClick={() => setClearing(null)} className={secondaryClass}>إلغاء</button>
      </div>
    </Modal>}
  </>
}
