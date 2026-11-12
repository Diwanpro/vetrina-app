'use client'

import { useEffect, useState } from 'react'
import DashboardShell from '@/components/dashboard/DashboardShell'
import KpiCard from '@/components/dashboard/KpiCard'
import SalesChart from '@/components/dashboard/SalesChart'
import { IconCash, IconSales, IconProfit, IconBalance, IconAlert, IconCredit } from '@/components/dashboard/icons'
import { fetchAllRows, todayRange } from '@/lib/cash'
import { scopeQuery } from '@/lib/access'
import { supabase } from '@/lib/supabase'
import { formatDzd, getAppContext } from '@/lib/app-context'
import { CreditPaymentToast } from '@/components/dashboard/CreditLedger'
import LowStockBell from '@/components/dashboard/LowStockBell'

function currentTimeLabel() {
  return new Date().toLocaleTimeString('ar-DZ', { hour: '2-digit', minute: '2-digit' })
}

export default function DashboardPage() {
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [stats, setStats] = useState({
    cash: 0,
    sales: 0,
    invoices: 0,
    average: 0,
    profit: 0,
    credit: 0,
    alerts: 0,
    checkedAt: currentTimeLabel(),
  })

  useEffect(() => {
    let cancelled = false

    async function load() {
      try {
        const ctx = await getAppContext()
        if (!ctx.user || !ctx.storeIds.length) throw new Error('تعذر تحديد المتجر لعرض الإحصائيات')
        const { from, to } = todayRange()

        let salesQuery = supabase
          .from('sales')
          .select('id, total_amount, cash_amount, payment_method, created_at, stores!inner(tenant_id)')
          .gte('created_at', from).lt('created_at', to).order('id')
        salesQuery = scopeQuery(salesQuery, ctx)

        // The alert threshold is configured per store, not hardcoded.
        let limit = 10
        if (ctx.storeId) {
          const store = await supabase.from('stores').select('low_stock_alert').eq('id', ctx.storeId).single()
          if (Number.isFinite(Number(store.data?.low_stock_alert))) limit = Number(store.data.low_stock_alert)
        }
        let inventoryQuery = supabase.from('inventory').select('id, stores!inner(tenant_id)', { count: 'exact', head: true }).lte('quantity', limit)
        inventoryQuery = scopeQuery(inventoryQuery, ctx)

        let itemsQuery = supabase
          .from('sale_items')
          .select('id, quantity, final_price, product_variants!inner(cost_price_avg, products!inner(tenant_id)), sales!inner(store_id, created_at, stores!inner(tenant_id))')
          .gte('sales.created_at', from).lt('sales.created_at', to).eq('product_variants.products.tenant_id', ctx.tenantId).order('id')
        itemsQuery = scopeQuery(itemsQuery, ctx, 'sales.store_id', 'sales.stores.tenant_id')

        const [sales, inventoryResult, items, creditTotal] = await Promise.all([
          fetchAllRows(salesQuery),
          inventoryQuery,
          fetchAllRows(itemsQuery),
          supabase.rpc('engine_total_credit', { p_store: ctx.allBranches ? null : ctx.storeId }),
        ])
        if (inventoryResult.error) throw inventoryResult.error
        if (creditTotal.error) console.error('[dashboard] total credit failed', creditTotal.error)
        if (cancelled) return

        const rows = sales || []
        const totalSales = rows.reduce((s, r) => s + Number(r.total_amount || 0), 0)
        const invoices = rows.length
        // Cash actually handed over, matching the drawer and the close-shift
        // calculation. total_amount would count the credit/cheque part too.
        const cash = rows.reduce((s, r) => s + Number(r.cash_amount || 0), 0)
        const average = invoices ? totalSales / invoices : 0
        const profit = (items || []).reduce((sum, item) => {
          const cost = Number(item.product_variants?.cost_price_avg || 0)
          const qty = Number(item.quantity || 0)
          const price = Number(item.final_price || 0)
          return sum + (price - cost) * qty
        }, 0)

        setStats({
          cash,
          sales: totalSales,
          invoices,
          average,
          profit,
          credit: Number(creditTotal.data || 0),
          alerts: inventoryResult.count || 0,
          checkedAt: currentTimeLabel(),
        })
        setError('')
      } catch (err) {
        if (!cancelled) setError(err.message || 'تعذر تحميل إحصائيات اليوم')
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    load()
    const interval = setInterval(load, 60000)
    window.addEventListener('focus', load)
    return () => {
      cancelled = true
      clearInterval(interval)
      window.removeEventListener('focus', load)
    }
  }, [])

  return (
    <DashboardShell active="/dashboard">
      <CreditPaymentToast />
      <div className="space-y-3">
        <div className="flex justify-end"><LowStockBell /></div>
        {loading && <p role="status" className="text-sm text-neutral-400">جاري تحميل إحصائيات اليوم...</p>}
        {error && <p role="alert" className="rounded-lg border border-red-900 bg-red-950/20 p-3 text-sm text-red-200">تعذر تحديث الإحصائيات: {error}</p>}
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-3">
          <KpiCard
            title="النقد في الصندوق"
            value={formatDzd(stats.cash)}
            subtitle="النقد المقبوض فعلياً في مبيعات اليوم"
            icon={IconCash}
          />
          <KpiCard
            title="مبيعات اليوم"
            value={formatDzd(stats.sales)}
            subtitle={`عدد الفواتير: ${stats.invoices} | متوسط الفاتورة: ${formatDzd(stats.average)}`}
            icon={IconSales}
          />
          <KpiCard
            title="الربح المحسوب"
            value={formatDzd(stats.profit)}
            subtitle="(السعر النهائي − سعر التكلفة) × الكمية"
            icon={IconProfit}
          />
          <KpiCard
            title="إجمالي الكريدي"
            value={formatDzd(stats.credit)}
            subtitle="مجموع المتبقي على الزبائن من جدول الكريدي"
            icon={IconCredit}
            accent="red"
          />
          <KpiCard
            title="الوضعية الصافية"
            value="—"
            subtitle="تقرير الوضعية الصافية غير متاح بعد"
            icon={IconBalance}
          />
          <KpiCard
            title="التنبيهات"
            value={String(stats.alerts)}
            subtitle={
              stats.alerts
                ? `منتجات منخفضة المخزون، آخر فحص: ${stats.checkedAt}`
                : `لا توجد تنبيهات، آخر فحص: ${stats.checkedAt}`
            }
            icon={IconAlert}
            accent="red"
          />
        </div>

        <SalesChart />
      </div>
    </DashboardShell>
  )
}
