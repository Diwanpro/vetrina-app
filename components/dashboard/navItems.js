import {
  IconDashboard,
  IconPos,
  IconSales,
  IconCredit,
  IconInventory,
  IconAccounting,
  IconOrders,
  IconSettings,
  IconTrips,
} from './icons'

// `mobile: true` marks the few destinations the phone bottom bar shows; the
// sidebar keeps every item, and the bar's «المزيد» opens the rest in a sheet.
// The flag lives here, next to the item, so there is still one source of truth.
// The order below is the sidebar's order and is unchanged; the flag only picks
// which of these the phone bar shows.
export const NAV_ITEMS = [
  { href: '/dashboard', label: 'لوحة التحكم', icon: IconDashboard, mobile: true },
  { href: '/dashboard/pos', label: 'نقطة البيع', icon: IconPos, mobile: true },
  { href: '/dashboard/orders', label: 'الطلبات', icon: IconOrders, badge: 'orders', mobile: true },
  { href: '/dashboard/operations', label: 'العمليات اليومية', icon: IconSales },
  { href: '/dashboard/customers-credit', label: 'الزبائن والكريدي', icon: IconCredit },
  // Opens on the products tab, which is the stock destination a phone user wants.
  { href: '/dashboard/stock', label: 'المخزون والموردون', icon: IconInventory, mobile: true },
  { href: '/dashboard/trips', label: 'رحلات الشراء', icon: IconTrips },
  { href: '/dashboard/management', label: 'الإدارة والمحاسبة', icon: IconAccounting },
  { href: '/dashboard/settings', label: 'الإعدادات', icon: IconSettings },
]

// The phone bar: the flagged items, in list order.
export const MOBILE_NAV_ITEMS = NAV_ITEMS.filter(item => item.mobile)
// Everything else, for the «المزيد» sheet.
export const MORE_NAV_ITEMS = NAV_ITEMS.filter(item => !item.mobile)

// Every legacy route maps back to the grouped page that now hosts it, so the
// sidebar highlight, the bottom nav and route gating all keep working without
// the sidebar growing again.
export const ROUTE_GROUPS = {
  '/dashboard/stock': '/dashboard/stock',
  '/dashboard/operations': '/dashboard/operations',
  '/dashboard/customers-credit': '/dashboard/customers-credit',
  '/dashboard/management': '/dashboard/management',
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
  '/dashboard/offers': '/dashboard/stock',
  '/dashboard/looks': '/dashboard/stock',
  '/dashboard/trips': '/dashboard/trips',
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
