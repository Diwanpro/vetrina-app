'use client'

import TabbedPage from '@/components/dashboard/TabbedPage'
import CreditsPage from '@/app/dashboard/_screens/credits'
import CustomersPage from '@/app/dashboard/_screens/customers'

const TABS = [
  { key: 'credits', label: 'الكريدي', href: '/dashboard/credits', component: CreditsPage },
  { key: 'customers', label: 'الزبائن', href: '/dashboard/customers', component: CustomersPage },
]

export default function CustomersCreditPage() {
  return <TabbedPage group="/dashboard/customers-credit" initialTab="credits" tabs={TABS} />
}
