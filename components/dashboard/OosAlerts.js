'use client'
import { useCallback, useEffect, useState } from 'react'
import { supabase } from '@/lib/supabase'
import { getAppContext } from '@/lib/app-context'
import { oosMessage } from '@/lib/inventory-alerts'

export default function OosAlerts() {
  const [rows, setRows] = useState([])
  const [context, setContext] = useState(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(null)
  const load = useCallback(async () => {
    try {
      const ctx = await getAppContext()
      if (!ctx.storeId || !['owner', 'manager'].includes(ctx.role)) { setRows([]); return }
      setContext(ctx)
      const { data, error } = await supabase.rpc('engine_oos', { p_store: ctx.storeId })
      if (error) throw error
      setRows(data || [])
      setError('')
    } catch (err) { setError(err.message) }
  }, [])
  useEffect(() => {
    load()
    const channel = supabase.channel('v32-stock-alerts').on('postgres_changes', { event: '*', schema: 'public', table: 'inventory' }, load).subscribe()
    // Fallback for deployments where Realtime publication is not enabled.
    const timer = setInterval(load, 10000)
    const refresh = () => { if (!document.hidden) load() }
    document.addEventListener('visibilitychange', refresh)
    return () => { clearInterval(timer); supabase.removeChannel(channel); document.removeEventListener('visibilitychange', refresh) }
  }, [load])
  async function replenish(row) {
    setBusy(row.id)
    try {
      const { error } = await supabase.rpc('engine_replenish_master', { p_store: context.storeId, p_variant: row.variant_id })
      if (error) throw error
      await load()
    } catch (err) { setError(err.message) }
    finally { setBusy(null) }
  }
  if (!context) return null
  return <section aria-label="تنبيهات نفاد المخزون" aria-live="polite" className="mb-4 space-y-2">
    {error && <p role="alert" className="text-xs text-red-300">{error}</p>}
    {rows.map(row => <article key={row.id} className="flex gap-3 rounded-xl border border-red-400/20 bg-[#191919] p-3">
      {row.image && <img src={row.image} alt={row.name} className="h-16 w-16 rounded-lg object-cover" />}
      <div><p className="text-sm text-red-200">نفد: {row.name} · {row.color} / {row.size}</p>
        <p className="mt-1 text-xs text-neutral-300">{oosMessage(row)}</p>
        {row.masterQuantity > 0 && <button type="button" disabled={busy !== null} onClick={() => replenish(row)} className="mt-2 rounded-lg bg-gold px-3 py-2 text-xs text-black disabled:opacity-50">{busy === row.id ? 'جاري النقل...' : `إضافة إلى المعرض (${row.masterQuantity})`}</button>}
      </div>
    </article>)}
  </section>
}
