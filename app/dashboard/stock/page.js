'use client'

import TabbedPage from '@/components/dashboard/TabbedPage'
import ProductsPage from '@/app/dashboard/_screens/products'
import InventoryPage from '@/app/dashboard/_screens/inventory'
import TransfersPage from '@/app/dashboard/_screens/transfers'
import SuppliersPage from '@/app/dashboard/_screens/suppliers'
import PurchasesPage from '@/app/dashboard/_screens/purchases'

const TABS = [
  { key: 'products', label: 'المنتجات', href: '/dashboard/products', component: ProductsPage },
  { key: 'inventory', label: 'المخزون', href: '/dashboard/inventory', component: InventoryPage },
  { key: 'transfers', label: 'نقل المخزون', href: '/dashboard/transfers', component: TransfersPage },
  { key: 'suppliers', label: 'الموردون', href: '/dashboard/suppliers', component: SuppliersPage },
  { key: 'purchases', label: 'المشتريات', href: '/dashboard/purchases', component: PurchasesPage },
]

export default function StockPage() {
  return <TabbedPage group="/dashboard/stock" initialTab="products" tabs={TABS} />
}
