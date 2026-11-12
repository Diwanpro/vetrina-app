'use client'

import DashboardShell from '@/components/dashboard/DashboardShell'
import LooksScreen from '@/app/dashboard/_screens/looks'

// The stock group hosts this as a tab; the bare route keeps old links and the
// sidebar highlight working.
export default function LooksPage() {
  return <DashboardShell active="/dashboard/looks"><LooksScreen /></DashboardShell>
}
