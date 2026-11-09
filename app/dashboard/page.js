'use client'

import { useEffect, useState } from 'react'
import DashboardShell from '@/components/dashboard/DashboardShell'
import KpiCard from '@/components/dashboard/KpiCard'
import SalesChart from '@/components/dashboard/SalesChart'
import { IconCash, IconSales, IconProfit, IconBalance, IconAlert } from '@/components/dashboard/icons'
import { supabase } from '@/lib/supabase'
import { formatDzd, getAppContext } from '@/lib/app-context'

function startOfTodayIso() {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  return d.toISOString()
}

function currentTimeLabel() {
  return new Date().toLocaleTimeString('ar-DZ', { hour: '2-digit', minute: '2-digit' })
}

export default function DashboardPage() {
  const [stats, setStats] = useState({
    cash: 0,
    sales: 0,
    invoices: 0,
    average: 0,
    profit: 0,
    alerts: 0,
    checkedAt: currentTimeLabel(),
  })

  useEffect(() => {
    let cancelled = false

    async function load() {
      const ctx = await getAppContext()
      const from = startOfTodayIso()

      let salesQuery = supabase
        .from('sales')
        .select('total_amount, payment_method, created_at')
        .gte('created_at', from)
      if (ctx.storeId) salesQuery = salesQuery.eq('store_id', ctx.storeId)

      let inventoryQuery = supabase.from('inventory').select('id, quantity').lt('quantity', 5)
      if (ctx.storeId) inventoryQuery = inventoryQuery.eq('store_id', ctx.storeId)

      const [{ data: sales }, { data: lowStock }] = await Promise.all([salesQuery, inventoryQuery])
      if (cancelled) return

      const rows = sales || []
      const totalSales = rows.reduce((s, r) => s + Number(r.total_amount || 0), 0)
      const invoices = rows.length
      const cash = rows
        .filter((r) => r.payment_method === 'cash')
        .reduce((s, r) => s + Number(r.total_amount || 0), 0)
      const average = invoices ? totalSales / invoices : 0
      const profit = totalSales * 0.2

      setStats({
        cash,
        sales: totalSales,
        invoices,
        average,
        profit,
        alerts: (lowStock || []).length,
        checkedAt: currentTimeLabel(),
      })
    }

    load()
    return () => {
      cancelled = true
    }
  }, [])

  return (
    <DashboardShell active="/dashboard">
      <div className="space-y-3">
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-3">
          <KpiCard
            title="النقد في الصندوق"
            value={formatDzd(stats.cash)}
            subtitle="الرصيد الافتتاحي والحركات النقدية لليوم"
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
            subtitle="هامش تقديري 20% من مبيعات اليوم"
            icon={IconProfit}
          />
          <KpiCard
            title="الوضعية الصافية"
            value="0 دج"
            subtitle="لنا: 0 دج | علينا: 0 دج"
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
