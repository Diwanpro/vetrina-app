'use client'

import DashboardShell from '@/components/dashboard/DashboardShell'
import OrdersScreen from '@/app/dashboard/_screens/orders'

export default function OrdersPage() {
  return <DashboardShell active="/dashboard/orders"><OrdersScreen /></DashboardShell>
}
