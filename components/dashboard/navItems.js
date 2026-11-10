import {
  IconDashboard,
  IconPos,
  IconProducts,
  IconSales,
  IconCredit,
  IconSuppliers,
  IconInventory,
  IconSettings,
} from './icons'

export const NAV_ITEMS = [
  { href: '/dashboard', label: 'لوحة التحكم', icon: IconDashboard },
  { href: '/dashboard/pos', label: 'نقطة البيع', icon: IconPos },
  { href: '/dashboard/products', label: 'المنتجات', icon: IconProducts },
  { href: '/dashboard/sales', label: 'المبيعات', icon: IconSales },
  { href: '/dashboard/credits', label: 'الكريدي', icon: IconCredit },
  { href: '/dashboard/suppliers', label: 'الموردون', icon: IconSuppliers },
  { href: '/dashboard/purchases', label: 'المشتريات', icon: IconInventory },
  { href: '/dashboard/inventory', label: 'المخزون', icon: IconInventory },
  { href: '/dashboard/settings', label: 'الإعدادات', icon: IconSettings },
]
