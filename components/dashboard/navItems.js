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
  { href: '/sales', label: 'المبيعات', icon: IconSales },
  { href: '/credit', label: 'الكريدي', icon: IconCredit },
  { href: '/suppliers', label: 'الموردون', icon: IconSuppliers },
  { href: '/inventory', label: 'المخزون', icon: IconInventory },
  { href: '/settings', label: 'الإعدادات', icon: IconSettings },
]
