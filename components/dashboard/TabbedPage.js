'use client'

import { Suspense, useCallback, useEffect, useRef, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import DashboardShell from '@/components/dashboard/DashboardShell'
import { Notice } from '@/components/dashboard/EngineUI'
import { useDashboardSession } from '@/components/dashboard/SessionProvider'
import { routeAllowed } from '@/lib/access'

// Tabs are addressed by URL (?tab=...) rather than component state so a tapped
// tab survives a reload, can be bookmarked, and keeps the back button honest.
function TabStrip({ tabs, value, onChange }) {
  return (
    <div role="tablist" aria-label="أقسام"
      className="mb-4 flex gap-1 overflow-x-auto rounded-xl border border-white/5 bg-[#161616] p-1">
      {tabs.map(tab => {
        const selected = tab.key === value
        return <button key={tab.key} type="button" role="tab" aria-selected={selected}
          onClick={() => onChange(tab.key)}
          className={`whitespace-nowrap rounded-lg px-3 py-2 text-sm transition ${
            selected
              ? 'bg-gold/15 font-medium text-gold shadow-[inset_0_0_0_1px_rgba(212,175,55,0.35)]'
              : 'text-neutral-400 hover:bg-white/5 hover:text-neutral-200'
          }`}>
          {tab.label}
        </button>
      })}
    </div>
  )
}

function TabbedContent({ tabs, group, initialTab }) {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const ctx = useDashboardSession()
  const requested = searchParams.get('tab')
  const allowed = tabs.filter(tab => !ctx || routeAllowed(ctx.role, tab.href))
  const tab = allowed.find(entry => entry.key === requested) || allowed.find(entry => entry.key === initialTab) || allowed[0]

  const query = searchParams.toString()
  const href = `${pathname}?${query}`
  const actual = tab?.key
  const rejected = ctx && tab && requested !== null && requested !== actual
  const message = !rejected ? '' : tabs.some(entry => entry.key === requested)
    ? `لا تملك صلاحية الوصول إلى هذا التبويب. تم فتح تبويب ${tab.label}`
    : 'التبويب المطلوب غير موجود'
  const [notice, setNotice] = useState(null)
  const handled = useRef(null)

  useEffect(() => {
    if (!message) {
      handled.current = null
      // Keep feedback on its corrected URL, not on subsequent valid visits.
      setNotice(previous => previous?.href === href ? previous : null)
      return
    }
    if (handled.current === href) return
    const next = new URLSearchParams(query)
    next.set('tab', actual)
    const target = `${pathname}?${next}`
    setNotice(previous => previous?.href === target && previous.message === message
      ? previous : { href: target, message })
    // The notice is committed before navigating; discard superseded attempts
    // (including Strict Mode effect replays) and only replace once per visit.
    let cancelled = false
    queueMicrotask(() => {
      if (cancelled) return
      handled.current = href
      router.replace(target + window.location.hash, { scroll: false })
    })
    return () => { cancelled = true }
  }, [href, query, pathname, actual, message, router])

  const change = useCallback((key) => {
    setNotice(null)
    const next = new URLSearchParams(query)
    if (group === '/dashboard/stock' && key !== 'purchases') next.delete('supplierId')
    next.set('tab', key)
    router.replace(`${pathname}?${next.toString()}`, { scroll: false })
  }, [group, pathname, router, query])

  if (!tab) return <DashboardShell active={group}><p className="text-sm text-neutral-400">لا توجد أقسام متاحة لحسابك.</p></DashboardShell>

  const Component = tab.component
  const visibleMessage = message || (notice?.href === href ? notice.message : '')
  return <DashboardShell active={group} tabHref={tab.href}>
    {visibleMessage && <Notice error={visibleMessage} />}
    <TabStrip tabs={allowed} value={tab.key} onChange={change} />
    {/* Keyed so switching tabs remounts and refetches, never showing stale rows. */}
    <div key={tab.key} role="tabpanel"><Component /></div>
  </DashboardShell>
}

export default function TabbedPage({ group, tabs, initialTab }) {
  return <Suspense fallback={<DashboardShell active={group}><p className="text-sm text-neutral-400">جاري التحميل...</p></DashboardShell>}>
    <TabbedContent group={group} tabs={tabs} initialTab={initialTab} />
  </Suspense>
}
