import Sidebar from '@/components/dashboard/Sidebar'
import BottomNav from '@/components/dashboard/BottomNav'
import TopBar from '@/components/dashboard/TopBar'
import KpiCard from '@/components/dashboard/KpiCard'
import SalesChart from '@/components/dashboard/SalesChart'
import { IconCash, IconSales, IconProfit, IconBalance, IconAlert } from '@/components/dashboard/icons'

export const dynamic = 'force-dynamic'

export default function DashboardPage() {
  return (
    <div className="min-h-screen bg-surface flex">
      <Sidebar active="/dashboard" />

      <div className="flex min-w-0 flex-1 flex-col pb-16 md:pb-0">
        <TopBar />

        <main className="p-3 md:p-4 space-y-3">
          <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-3">
            <KpiCard
              title="النقد في الصندوق"
              value="0 دج"
              subtitle="الرصيد الافتتاحي والحركات النقدية لليوم"
              icon={IconCash}
            />
            <KpiCard
              title="مبيعات اليوم"
              value="0 دج"
              subtitle="عدد الفواتير: 0 | متوسط الفاتورة: 0 دج"
              icon={IconSales}
            />
            <KpiCard
              title="الربح المحسوب"
              value="0 دج"
              subtitle="(يشمل 0 دج مبيعات بدون تكلفة معروفة)"
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
              value="0"
              subtitle="لا توجد تنبيهات، آخر فحص: الساعة الآن"
              icon={IconAlert}
              accent="red"
            />
          </div>

          <SalesChart />
        </main>
      </div>

      <BottomNav active="/dashboard" />
    </div>
  )
}
