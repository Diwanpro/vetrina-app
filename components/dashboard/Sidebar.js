'use client'

import { useDashboardSession } from './SessionProvider'
import { routeAllowed } from '@/lib/access'
import { NAV_ITEMS, activeGroup } from './navItems'
import OrdersBadge from './OrdersBadge'

export default function Sidebar({ active = '/dashboard' }) {
  const ctx = useDashboardSession()
  const group = activeGroup(active)
  return (
    <aside className="hidden md:flex w-[84px] shrink-0 flex-col items-center border-l border-white/5 bg-[#161616] py-3 min-h-screen sticky top-0">
      <img
        src="/logo.png"
        alt="Vetrina"
        width="73"
        height="40"
        className="h-10 w-auto max-w-full bg-transparent object-contain mb-4"
      />
      <nav className="flex flex-col items-center gap-1 w-full px-1.5">
        {NAV_ITEMS.filter(item => ctx && routeAllowed(ctx.role, item.href)).map((item) => {
          const Icon = item.icon
          const isActive = item.href === group
          return (
            <a
              key={item.href}
              href={item.href}
              className={`relative w-full flex flex-col items-center justify-center rounded-xl py-2 px-1 transition ${
                isActive
                  ? 'bg-gold/15 text-gold'
                  : 'text-neutral-400 hover:bg-white/5 hover:text-neutral-200'
              }`}
            >
              <Icon className="w-[18px] h-[18px]" />
              {item.badge === 'orders' && <OrdersBadge className="end-1.5" />}
              <span className="mt-1 text-[9px] leading-tight text-center">{item.label}</span>
            </a>
          )
        })}
      </nav>
    </aside>
  )
}
