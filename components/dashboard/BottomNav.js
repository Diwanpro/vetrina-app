'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { useDashboardSession } from './SessionProvider'
import { MOBILE_NAV_ITEMS, MORE_NAV_ITEMS, visibleNavItems, isNavItemActive } from './navItems'
import NavGroup from './NavGroup'
import OrdersBadge from './OrdersBadge'
import BottomSheet from './BottomSheet'

// Keep the primary bar short; the rest of the same menu lives in «المزيد».
export default function BottomNav({ active }) {
  const ctx = useDashboardSession()
  const router = useRouter()
  const [moreOpen, setMoreOpen] = useState(false)

  if (!ctx) return null

  const allowed = visibleNavItems(MOBILE_NAV_ITEMS, ctx.role)
  const moreItems = visibleNavItems(MORE_NAV_ITEMS, ctx.role)

  const go = href => {
    setMoreOpen(false)
    router.push(href)
  }

  const choice = item => {
    const Icon = item.icon
    const isActive = isNavItemActive(item, active)
    return (
      <button
        key={item.href}
        type="button"
        aria-current={isActive ? 'page' : undefined}
        onClick={() => go(item.href)}
        className={`flex w-full items-center gap-3 rounded-lg border px-3 py-3 text-start text-sm transition-colors ${
          isActive ? 'border-gold/40 bg-gold/10 text-gold' : 'border-white/10 bg-black/20 text-neutral-200 hover:bg-white/5'
        }`}
      >
        <Icon className="h-4 w-4 shrink-0" />
        <span className="min-w-0 flex-1 truncate">{item.label}</span>
      </button>
    )
  }

  return (
    <>
      <nav className="md:hidden fixed bottom-0 inset-x-0 z-40 border-t border-white/5 bg-[#161616]/95 backdrop-blur pb-[env(safe-area-inset-bottom)]">
        <div className="flex">
          {allowed.map(item => {
            const Icon = item.icon
            const isActive = isNavItemActive(item, active)
            return (
              <a
                key={item.href}
                href={item.href}
                aria-current={isActive ? 'page' : undefined}
                className={`relative flex min-w-0 flex-1 flex-col items-center py-2 px-1 ${
                  isActive ? 'text-gold' : 'text-neutral-500'
                }`}
              >
                <Icon className="w-4 h-4" />
                {item.badge === 'orders' && <OrdersBadge className="end-3 top-0" />}
                <span className="mt-1 text-[9px] leading-tight text-center">{item.label}</span>
              </a>
            )
          })}
          <button
            type="button"
            onClick={() => setMoreOpen(true)}
            aria-haspopup="dialog"
            aria-expanded={moreOpen}
            className={`relative flex min-w-0 flex-1 flex-col items-center py-2 px-1 ${
              moreItems.some(item => isNavItemActive(item, active)) ? 'text-gold' : 'text-neutral-500'
            }`}
          >
            <span aria-hidden="true" className="flex h-4 w-4 items-center justify-center text-base leading-none">⋯</span>
            <span className="mt-1 text-[9px] leading-tight text-center">المزيد</span>
          </button>
        </div>
      </nav>

      <BottomSheet
        open={moreOpen}
        onClose={() => setMoreOpen(false)}
        title="كل الوجهات"
        labelledBy="more-nav-title"
        closeLabel="إغلاق"
      >
        <ul className="space-y-1">
          {moreItems.length === 0 && (
            <li className="px-3 py-2 text-xs text-neutral-500">لا توجد وجهات أخرى متاحة لحسابك.</li>
          )}
          {moreItems.map(item => (
            <li key={item.href || item.label}>
              {item.children
                ? <NavGroup label={item.label}>{item.children.map(choice)}</NavGroup>
                : choice(item)}
            </li>
          ))}
        </ul>
      </BottomSheet>
    </>
  )
}
