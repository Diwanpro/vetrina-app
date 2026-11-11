'use client'

import { useEffect, useState } from 'react'
import { useDashboardSession } from './SessionProvider'
import { changeBranch } from '@/lib/app-context'
import { pendingRows } from '@/lib/local-db'
import { syncPending } from '@/lib/sync'
import ExpenseButton from './ExpenseButton'
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
    return () => {
      live = false
      clearInterval(timer)
      window.removeEventListener('online', refresh)
      window.removeEventListener('offline', refresh)
      window.removeEventListener('vetrina:outbox', refresh)
    }
  }, [ctx])

  if (!ctx) return null

  const pendingErrors = pending.some(row => row.status === 'error')
  const storeName = ctx.stores.find(store => store.id === ctx.storeId)?.name

  return <header className="sticky top-0 z-30 border-b border-white/5 bg-[#141414]/95 backdrop-blur">
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5 px-3 py-2 md:px-4">
      <img src="/logo.png" alt="Vetrina" width="57" height="31"
        className="h-7 w-auto shrink-0 bg-transparent object-contain md:hidden" />

      {/* Date and connection state share the flexible row. min-w-0 plus truncate
          is what stops the date from being clipped on a narrow phone. */}
      <div className="min-w-0 flex-1">
        <p className="truncate whitespace-nowrap text-xs text-neutral-100 sm:text-sm">
          {new Date().toLocaleDateString('ar-DZ', { weekday: 'long', month: 'long', day: 'numeric' })}
        </p>
        <p className={`mt-0.5 truncate whitespace-nowrap text-[11px] ${online ? 'text-neutral-500' : 'text-amber-300'}`}>
          {online ? 'متصل بالإنترنت' : 'وضع دون اتصال'}
          {/* The pending counter is the only part worth keeping on a phone. */}
          {pending.length > 0 && <span> · {pending.length} بانتظار المزامنة</span>}
        </p>
      </div>

      {/* Branch selector: full width on its own row on mobile, inline from sm up. */}
      <div className="order-last w-full min-w-0 sm:order-none sm:w-auto">
        {ctx.role === 'owner' ? <label className="block text-xs text-neutral-400">
          <span className="sr-only">اختيار الفرع</span>
          <select aria-label="اختيار الفرع"
            value={ctx.allBranches ? 'all' : ctx.storeId || ''}
            onChange={event => {
              if (confirm('تغيير الفرع سيغلق المسودات غير المحفوظة. متابعة؟')) changeBranch(ctx, event.target.value)
              else event.target.value = ctx.allBranches ? 'all' : ctx.storeId || ''
            }}
            className="select-field w-full max-w-full rounded-lg border border-gold/20 bg-[#1c1c1c] px-2 py-2 text-xs text-gold sm:w-auto sm:max-w-48">
            <option value="all">كل الفروع</option>
            {!ctx.stores.length && <option value="">لا توجد فرع</option>}
            {ctx.stores.map(store => <option key={store.id} value={store.id}>{store.name}</option>)}
          </select>
        </label>
          : <span className="block truncate whitespace-nowrap text-xs text-neutral-400">{storeName}</span>}
      </div>

      <div className="flex shrink-0 items-center gap-1.5">
        {pending.length > 0 && <button
          disabled={!online || syncing}
          onClick={async () => {
            setSyncing(true); setError('')
            try { await syncPending() } catch (err) { setError(err.message) } finally { setSyncing(false) }
          }}
          className="rounded-lg border border-gold/20 px-2 py-2 text-xs text-gold disabled:opacity-40">
          {/* Long label only where there is room for it. */}
          <span className="hidden sm:inline">{syncing ? 'جاري المزامنة...' : 'مزامنة الآن'}</span>
          <span className="sm:hidden">{syncing ? '...' : 'مزامنة'}</span>
        </button>}
        <ExpenseButton />
        {ctx.storeId && <ShiftManager />}
      </div>
    </div>

    {(error || pendingErrors) && <p role="alert" className="px-3 pb-2 text-xs text-red-300 md:px-4">
      {error || 'توجد فواتير تحتاج مراجعة؛ افتح الإعدادات للاطلاع على سبب تعذر المزامنة.'}
    </p>}
  </header>
}
