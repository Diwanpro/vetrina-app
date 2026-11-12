'use client'

import { useEffect, useState } from 'react'
import { supabase } from '@/lib/supabase'
import { useDashboardSession } from './SessionProvider'

// Polling is deliberate: the dashboard is often left open on the counter, and a
// new web order should show up without the merchant refreshing the page.
const REFRESH_MS = 60000

export default function OrdersBadge({ className = '' }) {
  const ctx = useDashboardSession()
  const [count, setCount] = useState(0)

  useEffect(() => {
    if (!ctx?.tenantId) return undefined
    let live = true

    async function refresh() {
      let query = supabase
        .from('orders')
        .select('id', { count: 'exact', head: true })
        .eq('status', 'new')
      query = ctx.allBranches ? query.eq('tenant_id', ctx.tenantId) : query.eq('store_id', ctx.storeId)
      const { count: total, error } = await query
      // A failed count must never break navigation; the badge just stays put.
      if (!error && live) setCount(total || 0)
    }

    refresh()
    const timer = setInterval(refresh, REFRESH_MS)
    window.addEventListener('focus', refresh)
    return () => { live = false; clearInterval(timer); window.removeEventListener('focus', refresh) }
  }, [ctx?.tenantId, ctx?.storeId, ctx?.allBranches])

  if (!count) return null
  return (
    <span
      aria-label={`${count} طلبات جديدة`}
      className={`absolute -top-1 end-2 flex h-4 min-w-4 items-center justify-center rounded-full bg-red-500 px-1 text-[9px] font-bold text-white ${className}`}
    >
      {count > 99 ? '99+' : count}
    </span>
  )
}
