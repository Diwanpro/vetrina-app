'use client'

import { useEffect, useState } from 'react'
import { getAppContext } from '@/lib/app-context'
import { scopeQuery } from '@/lib/access'
import { fetchAllRows } from '@/lib/cash'
import { supabase } from '@/lib/supabase'

export default function InventoryPage() {
  const [rows, setRows] = useState([])
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  useEffect(() => {
    let live = true
    ;(async () => {
      try {
        const ctx = await getAppContext()
        const data = await fetchAllRows(scopeQuery(supabase.from('inventory')
          .select('id, quantity, stores!inner(tenant_id), product_variants!inner(color, size, barcode, products!inner(name, tenant_id))')
          .eq('product_variants.products.tenant_id', ctx.tenantId).order('id'), ctx))
        if (live) setRows(data)
      } catch (err) { if (live) setError(err.message) } finally { if (live) setLoading(false) }
    })()
    return () => { live = false }
  }, [])
  return <><h1 className="mb-4 text-xl text-neutral-100">المخزون</h1>{error && <p role="alert" className="mb-4 text-red-300">{error}</p>}{loading ? <p className="text-neutral-500">جاري التحميل...</p> : <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">{rows.map(row => <article key={row.id} className="rounded-xl border border-white/10 bg-card p-4"><h2 className="text-neutral-200">{row.product_variants.products.name}</h2><p className="mt-2 text-sm text-neutral-400">{row.product_variants.color} / {row.product_variants.size}</p><p className={`mt-3 text-lg ${row.quantity < 5 ? 'text-red-300' : 'text-gold'}`}>{row.quantity} قطعة</p></article>)}</div>}</>
}
