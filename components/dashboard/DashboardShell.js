'use client'
import { usePathname } from 'next/navigation'
import { activeGroup } from './navItems'
import { useDashboardSession } from './SessionProvider'
import Sidebar from './Sidebar'
import BottomNav from './BottomNav'
import TopBar from './TopBar'

export default function DashboardShell({ active, tabHref, children }) {
  const ctx = useDashboardSession()
  const pathname = usePathname()
  // Use the tab actually rendered (including a role-based fallback), not just
  // the shared container pathname or an untrusted ?tab= value.
  const group = activeGroup(tabHref || pathname || active)
  return (
    <div data-branch-specialty={ctx?.storeType} className={`min-h-screen bg-surface flex ${ctx?.storeTheme === 'feminine' ? 'dashboard-theme-feminine' : ''}`}>
      <Sidebar active={group} />
      <div className="flex min-w-0 flex-1 flex-col pb-16 md:pb-0">
        <TopBar />
        <main className="p-3 md:p-4">{children}</main>
      </div>
      <BottomNav active={group} />
    </div>
  )
}
