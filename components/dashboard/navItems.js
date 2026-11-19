import {
  IconDashboard,
  IconPos,
  IconSales,
  IconCredit,
  IconInventory,
  IconAccounting,
  IconOrders,
  IconSettings,
  IconSuppliers,
  IconCollections,
  IconTrips,
  IconTransfer,
} from './icons'
import { routeAllowed } from '@/lib/access'

// Link straight to the existing tab, but gate it on the same underlying route
// as TabbedPage. The /dashboard/stock container itself is open to all roles.
function stockTab(tab) {
  return { href: `/dashboard/stock?tab=${tab}`, accessPath: `/dashboard/${tab}` }
}

// One menu for both surfaces. Non-link groups only exist when a child is visible.
// `mobile` picks the four primary shortcuts; everything else goes in «المزيد».
export const NAV_ITEMS = [
  { href: '/dashboard', label: 'لوحة التحكم', icon: IconDashboard, mobile: true },
  { href: '/dashboard/pos', label: 'نقطة البيع', icon: IconPos, mobile: true },
  { href: '/dashboard/orders', label: 'الطلبات', icon: IconOrders, badge: 'orders', mobile: true },
  { href: '/dashboard/operations', label: 'العمليات اليومية', icon: IconSales },
  { href: '/dashboard/customers-credit', label: 'الزبائن والكريدي', icon: IconCredit },
  { ...stockTab('inventory'), label: 'المخزون', icon: IconInventory, mobile: true },
  { ...stockTab('transfers'), label: 'نقل المخزون', icon: IconTransfer },
  { label: 'التوريد والمشتريات', children: [
    { ...stockTab('suppliers'), label: 'الموردون', icon: IconSuppliers },
    { ...stockTab('purchases'), label: 'المشتريات', icon: IconCollections },
    { href: '/dashboard/trips', label: 'رحلات الشراء', icon: IconTrips },
  ] },
  { href: '/dashboard/management', label: 'الإدارة والمحاسبة', icon: IconAccounting },
  { href: '/dashboard/settings', label: 'الإعدادات', icon: IconSettings },
]

// The phone bar: the flagged items, in list order.
export const MOBILE_NAV_ITEMS = NAV_ITEMS.filter(item => item.mobile)
// Everything else, for the «المزيد» sheet.
export const MORE_NAV_ITEMS = NAV_ITEMS.filter(item => !item.mobile)

export function visibleNavItems(items, role) {
  const allowed = item => routeAllowed(role, item.accessPath || item.href)
  return items.flatMap(item => {
    if (!item.children) return allowed(item) ? [item] : []
    const children = item.children.filter(allowed)
    return children.length ? [{ ...item, children }] : []
  })
}

// Navigation keys, not redirects. Products, offers and looks still belong to
// stock; transfers and procurement now have their own highlighted entries.
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
  '/dashboard/transfers': '/dashboard/transfers',
  '/dashboard/suppliers': '/dashboard/suppliers',
  '/dashboard/purchases': '/dashboard/purchases',
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

export function isNavItemActive(item, group) {
  if (item.children) return item.children.some(child => isNavItemActive(child, group))
  return activeGroup(item.accessPath || item.href) === group
}
