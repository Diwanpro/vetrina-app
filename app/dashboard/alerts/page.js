'use client'
import { Suspense } from 'react'
import { useSearchParams } from 'next/navigation'
import DashboardShell from '@/components/dashboard/DashboardShell'
import OosAlerts from '@/components/dashboard/OosAlerts'
function Alerts() {
  const params = useSearchParams()
  return <DashboardShell active="/dashboard"><h1 className="mb-4 text-lg text-gold">تنبيهات نفاد المخزون</h1><OosAlerts storeId={params.get('store')} /></DashboardShell>
}
export default function AlertsPage() {
  return <Suspense fallback={<p>جاري التحميل...</p>}><Alerts /></Suspense>
}
