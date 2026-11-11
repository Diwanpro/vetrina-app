'use client'

import DashboardShell from '@/components/dashboard/DashboardShell'
import SettingsScreen from '@/app/dashboard/_screens/settings'

export default function SettingsPage() {
  return <DashboardShell active="/dashboard/settings"><SettingsScreen /></DashboardShell>
}
