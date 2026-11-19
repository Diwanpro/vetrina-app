'use client'

import { useEffect, useMemo, useState } from 'react'
import { Modal, Notice } from './EngineUI'
import { supabase } from '@/lib/supabase'
import { formatDzd } from '@/lib/app-context'

// Read the receipt, not the trip totals or the latest purchase for its supplier.
// Only read lines after the existing branch-authorized RPC has returned this ID.
export default function TripPurchaseInvoice({ purchaseId, storeId, tenantId, variants, onClose }) {
  const [result, setResult] = useState(null)
  const variantLabels = useMemo(() => new Map(variants.map(v => [v.id, v.label])), [variants])
  useEffect(() => {
    let live = true
    async function read() {
      try {
        const { data: invoice, error } = await supabase.rpc('engine_purchases', { p_store: storeId, p_tenant: tenantId }, { get: true })
          .select('id, supplier_name, description, created_at, total_amount')
          .eq('store_id', storeId).eq('tenant_id', tenantId).eq('id', purchaseId).maybeSingle()
        if (error) throw error
        if (!invoice) throw new Error('لم تعد الفاتورة المرتبطة متاحة في هذا الفرع.')
        if (!live) return
        const lines = await supabase.from('purchase_items').select('id, variant_id, quantity, unit_cost')
          .eq('store_id', storeId).eq('tenant_id', tenantId).eq('purchase_id', invoice.id).order('id')
        if (lines.error) throw lines.error
        if (live) setResult({ invoice, lines: lines.data || [] })
      } catch (err) { if (live) setResult({ error: err.message || 'تعذر عرض فاتورة الرحلة.' }) }
    }
    read()
    return () => { live = false }
  }, [purchaseId, storeId, tenantId])

  const invoice = result?.invoice
  return <Modal title="فاتورة الرحلة" onClose={onClose} wide>
    {!result ? <p role="status" className="text-sm text-neutral-400">جاري تحميل الفاتورة...</p>
      : result.error ? <Notice error={result.error} /> : <div className="space-y-4">
        <p className="text-xs text-neutral-400">فاتورة شراء مسجّلة · للقراءة فقط</p>
        <dl className="grid gap-3 rounded-xl border border-white/10 p-4 text-sm text-neutral-200 sm:grid-cols-2">
          <div><dt className="text-xs text-neutral-400">معرّف الفاتورة</dt><dd><bdi dir="ltr" className="break-all">{invoice.id}</bdi></dd></div>
          <div><dt className="text-xs text-neutral-400">التاريخ</dt><dd>{invoice.created_at ? new Date(invoice.created_at).toLocaleString('ar-DZ') : '—'}</dd></div>
          <div><dt className="text-xs text-neutral-400">المورد</dt><dd>{invoice.supplier_name || '—'}</dd></div>
          <div><dt className="text-xs text-neutral-400">الإجمالي</dt><dd className="text-gold">{formatDzd(invoice.total_amount)}</dd></div>
          {invoice.description && <div className="sm:col-span-2"><dt className="text-xs text-neutral-400">الوصف</dt><dd className="whitespace-pre-wrap break-words">{invoice.description}</dd></div>}
        </dl>
        {result.lines.length ? <div className="overflow-x-auto"><table aria-label="بنود الفاتورة" className="w-full text-right text-sm">
          <thead className="text-neutral-400"><tr><th className="p-2">المنتج والمقاس</th><th className="p-2">الكمية</th><th className="p-2">تكلفة الوحدة</th></tr></thead>
          <tbody>{result.lines.map(line => <tr key={line.id} className="border-t border-white/5">
            <td className="p-2">{variantLabels.get(line.variant_id) || <bdi dir="ltr" className="break-all">{line.variant_id}</bdi>}</td>
            <td className="p-2">{line.quantity}</td><td className="p-2">{formatDzd(line.unit_cost)}</td>
          </tr>)}</tbody>
        </table></div> : <p className="text-sm text-neutral-400">لا توجد بنود متاحة للعرض.</p>}
      </div>}
  </Modal>
}
