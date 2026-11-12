'use client'

import DashboardShell from '@/components/dashboard/DashboardShell'
import TripsScreen from '@/app/dashboard/_screens/trips'

export default function TripsPage() {
  return <DashboardShell active="/dashboard/trips"><TripsScreen /></DashboardShell>
}
