'use client'

import { useEffect, useState } from 'react'
import { useDashboardSession } from './SessionProvider'
import { changeBranch } from '@/lib/app-context'
import { pendingRows } from '@/lib/local-db'
import { syncPending } from '@/lib/sync'
import ShiftManager from './ShiftManager'

export default function TopBar() {
  const ctx = useDashboardSession()
  const [online, setOnline] = useState(true)
  const [pending, setPending] = useState([])
  const [error, setError] = useState('')
  const [syncing, setSyncing] = useState(false)
  useEffect(() => {
    let live = true
    const refresh = () => {
      setOnline(navigator.onLine && !ctx?.offline)
      if (ctx) pendingRows(ctx).then(rows => { if (live) setPending(rows) }).catch(err => { if (live) setError(err.message) })
    }
    refresh(); window.addEventListener('online', refresh); window.addEventListener('offline', refresh); window.addEventListener('vetrina:outbox', refresh)
    const timer = setInterval(refresh, 10000)
    return () => { live = false; clearInterval(timer); window.removeEventListener('online', refresh); window.removeEventListener('offline', refresh); window.removeEventListener('vetrina:outbox', refresh) }
  }, [ctx])
  if (!ctx) return null
  return <header className="sticky top-0 z-30 border-b border-white/5 bg-[#141414]/95 backdrop-blur">
    <div className="flex flex-wrap items-center gap-2 px-3 py-2.5 md:px-4">
      <img src="/vetrina_logo_main.png" alt="Vetrina" className="h-8 w-8 rounded-lg md:hidden" />
      <div className="min-w-0 flex-1"><p className="truncate text-sm text-neutral-100">{new Date().toLocaleDateString('ar-DZ', { weekday: 'long', month: 'long', day: 'numeric' })}</p><p className={`mt-1 text-[11px] ${online ? 'text-neutral-500' : 'text-amber-300'}`}>{online ? 'متصل بالإنترنت' : 'وضع دون اتصال'} · {pending.length} بانتظار المزامنة</p></div>
      {ctx.role === 'owner' ? <label className="text-xs text-neutral-400"><span className="sr-only">اختيار الفرع</span><select aria-label="اختيار الفرع" value={ctx.allBranches ? 'all' : ctx.storeId || ''} onChange={event => {
        if (confirm('تغيير الفرع سيغلق المسودات غير المحفوظة. متابعة؟')) changeBranch(ctx, event.target.value)
        else event.target.value = ctx.allBranches ? 'all' : ctx.storeId || ''
      }} className="max-w-48 rounded-lg border border-gold/20 bg-[#1c1c1c] px-2 py-2 text-xs text-gold"><option value="all">كل الفروع</option>{!ctx.stores.length && <option value="">لا توجد فروع</option>}{ctx.stores.map(store => <option key={store.id} value={store.id}>{store.name}</option>)}</select></label>
        : <span className="text-xs text-neutral-400">{ctx.stores.find(store => store.id === ctx.storeId)?.name}</span>}
      {pending.length > 0 && <button disabled={!online || syncing} onClick={async () => { setSyncing(true); setError(''); try { await syncPending() } catch (err) { setError(err.message) } finally { setSyncing(false) } }} className="rounded-lg border border-gold/20 px-2 py-2 text-xs text-gold disabled:opacity-40">{syncing ? 'جاري المزامنة...' : 'مزامنة الآن'}</button>}
      {ctx.storeId && online && pending.length === 0 && <ShiftManager />}
    </div>
    {(error || pending.some(row => row.status === 'error')) && <p role="alert" className="px-4 pb-2 text-xs text-red-300">{error || 'توجد فواتير تحتاج مراجعة؛ افتح الإعدادات للاطلاع على سبب تعذر المزامنة.'}</p>}
  </header>
}
