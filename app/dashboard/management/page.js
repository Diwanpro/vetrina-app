'use client'

import TabbedPage from '@/components/dashboard/TabbedPage'
import AccountingPage from '@/app/dashboard/_screens/accounting'
import UsersPage from '@/app/dashboard/_screens/users'

const TABS = [
  { key: 'accounting', label: 'المحاسبة', href: '/dashboard/accounting', component: AccountingPage },
  { key: 'employees', label: 'الموظفون', href: '/dashboard/users', component: UsersPage },
]

export default function ManagementPage() {
  return <TabbedPage group="/dashboard/management" initialTab="accounting" tabs={TABS} />
}
