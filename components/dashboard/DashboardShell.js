'use client'
import { useDashboardSession } from './SessionProvider'
import Sidebar from './Sidebar'
import BottomNav from './BottomNav'
import TopBar from './TopBar'

// `active` drives the sidebar highlight; grouped pages pass their sidebar href
// and render `content` bare inside their own tab strip.
export default function DashboardShell({ active, children }) {
  const ctx = useDashboardSession()
  return (
    <div data-branch-specialty={ctx?.storeType} className={`min-h-screen bg-surface flex ${ctx?.storeTheme === 'feminine' ? 'dashboard-theme-feminine' : ''}`}>
      <Sidebar active={active} />
      <div className="flex min-w-0 flex-1 flex-col pb-16 md:pb-0">
        <TopBar />
        <main className="p-3 md:p-4">{children}</main>
      </div>
      <BottomNav active={active} />
    </div>
  )
}
