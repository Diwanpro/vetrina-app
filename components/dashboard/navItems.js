import {
  IconDashboard,
  IconPos,
  IconSales,
  IconCredit,
  IconInventory,
  IconAccounting,
  IconOrders,
  IconSettings,
} from './icons'

export const NAV_ITEMS = [
  { href: '/dashboard', label: 'لوحة التحكم', icon: IconDashboard },
  { href: '/dashboard/pos', label: 'نقطة البيع', icon: IconPos },
  { href: '/dashboard/orders', label: 'الطلبات', icon: IconOrders, badge: 'orders' },
  { href: '/dashboard/operations', label: 'العمليات اليومية', icon: IconSales },
  { href: '/dashboard/customers-credit', label: 'الزبائن والكريدي', icon: IconCredit },
  { href: '/dashboard/stock', label: 'المخزون والموردون', icon: IconInventory },
  { href: '/dashboard/management', label: 'الإدارة والمحاسبة', icon: IconAccounting },
  { href: '/dashboard/settings', label: 'الإعدادات', icon: IconSettings },
]

// Every legacy route maps back to the grouped page that now hosts it, so the
// sidebar highlight, the bottom nav and route gating all keep working without
// the sidebar growing again.
export const ROUTE_GROUPS = {
  '/dashboard': '/dashboard',
  '/dashboard/pos': '/dashboard/pos',
  '/dashboard/orders': '/dashboard/orders',
  '/dashboard/sales': '/dashboard/operations',
  '/dashboard/collections': '/dashboard/operations',
  '/dashboard/expenses': '/dashboard/operations',
  '/dashboard/credits': '/dashboard/customers-credit',
  '/dashboard/customers': '/dashboard/customers-credit',
  '/dashboard/products': '/dashboard/stock',
  '/dashboard/inventory': '/dashboard/stock',
  '/dashboard/transfers': '/dashboard/stock',
  '/dashboard/suppliers': '/dashboard/stock',
  '/dashboard/purchases': '/dashboard/stock',
  '/dashboard/accounting': '/dashboard/management',
  '/dashboard/users': '/dashboard/management',
  '/dashboard/settings': '/dashboard/settings',
}

export function activeGroup(path) {
  if (!path) return '/dashboard'
  const key = Object.keys(ROUTE_GROUPS)
    .filter(href => path === href || path.startsWith(href + '/'))
    .sort((a, b) => b.length - a.length)[0]
  return key ? ROUTE_GROUPS[key] : path
}
