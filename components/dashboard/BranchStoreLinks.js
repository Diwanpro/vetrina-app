'use client'
import { useState } from 'react'
import CustomSelect from '@/components/ui/CustomSelect'
import { branchStoreHref } from '@/lib/branch-store'

export function StorefrontLink({ ctx, label = 'عرض المتجر الإلكتروني' }) {
  const href = branchStoreHref(ctx?.stores, ctx?.storeId)
  return href ? <a href={href} target="_blank" rel="noopener noreferrer" className="rounded-lg bg-gold px-3 py-2 text-sm font-semibold text-[#121212]">{label}</a>
    : <span className="text-xs text-neutral-500">{ctx?.storeId ? 'رابط متجر هذا الفرع غير مضبوط' : 'اختر فرعاً لعرض متجره'}</span>
}
export default function BranchStoreLinks({ ctx }) {
  const [selected, setSelected] = useState('')
  if (!ctx || !['owner', 'manager'].includes(ctx.role)) return null
  const stores = ctx.role === 'owner' ? ctx.stores || [] : (ctx.stores || []).filter(row => row.id === ctx.assignedStoreId || row.id === ctx.storeId)
  const storeId = stores.some(store => store.id === selected) ? selected : stores.find(store => store.id === ctx.storeId)?.id || stores[0]?.id || ''
  return <div className="flex w-full flex-wrap items-center gap-2 border-t border-white/5 px-3 py-2 md:px-4">
    <span className="text-xs text-neutral-400">متاجر الفروع (للعرض فقط)</span>
    <CustomSelect aria-label="اختيار فرع المتجر الإلكتروني" value={storeId} onChange={setSelected} options={stores.map(store => ({ value: store.id, label: store.name }))} className="min-w-36 rounded-lg border border-gold/20 bg-[#1c1c1c] px-2 py-2 text-xs text-gold" />
    <StorefrontLink ctx={{ stores, storeId }} label="عرض متجر هذا الفرع" />
  </div>
}
