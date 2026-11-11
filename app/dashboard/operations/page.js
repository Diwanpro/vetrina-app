'use client'

import TabbedPage from '@/components/dashboard/TabbedPage'
import SalesPage from '@/app/dashboard/_screens/sales'
import CollectionsPage from '@/app/dashboard/_screens/collections'
import ExpensesPage from '@/app/dashboard/_screens/expenses'

const TABS = [
  { key: 'sales', label: 'سجل المبيعات', href: '/dashboard/sales', component: SalesPage },
  { key: 'collections', label: 'المستحقات', href: '/dashboard/collections', component: CollectionsPage },
  { key: 'expenses', label: 'المصاريف', href: '/dashboard/expenses', component: ExpensesPage },
]

export default function OperationsPage() {
  return <TabbedPage group="/dashboard/operations" initialTab="sales" tabs={TABS} />
}
