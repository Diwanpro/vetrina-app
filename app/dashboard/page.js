'use client'

import { useEffect, useState } from 'react'
import DashboardShell from '@/components/dashboard/DashboardShell'
import KpiCard from '@/components/dashboard/KpiCard'
import SalesChart from '@/components/dashboard/SalesChart'
import { IconCash, IconSales, IconProfit, IconBalance, IconAlert, IconCredit, IconExpenses } from '@/components/dashboard/icons'
import { fetchAllRows, todayRange } from '@/lib/cash'
import { scopeQuery } from '@/lib/access'
import { supabase } from '@/lib/supabase'
import { formatDzd, getAppContext } from '@/lib/app-context'
import { CreditPaymentToast } from '@/components/dashboard/CreditLedger'
import LowStockBell from '@/components/dashboard/LowStockBell'
import { Modal } from '@/components/dashboard/EngineUI'

function currentTimeLabel() {
  return new Date().toLocaleTimeString('ar-DZ', { hour: '2-digit', minute: '2-digit' })
}

// The closing cash figure the shift close would compute, assembled from the
// same parts so the breakdown in the drawer modal adds up to the KPI above it.
function drawerTotal(breakdown) {
  return breakdown.reduce((sum, line) => sum + Number(line.amount || 0), 0)
}

function Breakdown({ lines }) {
  return (
    <dl className="divide-y divide-white/5 rounded-xl border border-white/5 bg-black/20">
      {lines.map(line => (
        <div key={line.label} className="flex items-center justify-between gap-3 px-3 py-2.5">
          <dt className="text-sm text-neutral-300">{line.label}</dt>
          <dd className={`text-sm font-medium tabular-nums ${line.amount < 0 ? 'text-red-300' : 'text-neutral-100'}`}>
            {formatDzd(line.amount)}
          </dd>
        </div>
      ))}
    </dl>
  )
}

// The per-KPI detail list. One modal serves every card; the shape of the body is
// decided by `detail.rows`.
function KpiModal({ detail, onClose }) {
  if (!detail) return null
  const { title, total, subtitle, breakdown, rows, empty, columns } = detail
  return (
    <Modal title={title} onClose={onClose} wide>
      <div className="mb-4 rounded-xl border border-gold/20 bg-gold/5 p-3.5">
        <p className="text-xs text-neutral-400">{subtitle}</p>
        <p className="mt-1 text-xl font-bold text-gold">{total}</p>
      </div>

      {breakdown ? (
        <div className="space-y-3">
          <Breakdown lines={breakdown} />
          <div className="flex items-center justify-between gap-3 rounded-xl border border-gold/20 px-3 py-2.5">
            <span className="text-sm font-medium text-gold">الصافي</span>
            <span className="text-sm font-bold tabular-nums text-gold">{formatDzd(drawerTotal(breakdown))}</span>
          </div>
        </div>
      ) : null}

      {rows ? (
        rows.length === 0 ? (
          <p className="py-6 text-center text-sm text-neutral-500">{empty || 'لا توجد حركات اليوم'}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-white/10 text-xs text-neutral-500">
                  {columns.map(column => (
                    <th key={column.key} className="whitespace-nowrap p-2 font-normal" style={{ textAlign: column.align || 'right' }}>
                      {column.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map(row => (
                  <tr key={row.key} className="border-b border-white/5 last:border-0">
                    {columns.map(column => (
                      <td key={column.key} className="whitespace-nowrap p-2 text-neutral-300" style={{ textAlign: column.align || 'right' }}>
                        {row[column.key]}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      ) : null}
    </Modal>
  )
}

function paymentLabel(row) {
  if (row.payment_method === 'credit') return 'كريدي'
  if (row.payment_method === 'mixed') return 'مختلط'
  return 'نقداً'
}

export default function DashboardPage() {
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [detail, setDetail] = useState(null)
  const [stats, setStats] = useState({
    cash: 0,
    sales: 0,
    invoices: 0,
    average: 0,
    profit: 0,
    expenses: 0,
    credit: 0,
    alerts: 0,
    opening: 0,
    creditPayments: 0,
    collections: 0,
    employeePayments: 0,
    checkedAt: currentTimeLabel(),
    saleRows: [],
    expenseRows: [],
    profitRows: [],
    alertRows: [],
    shiftOpen: false,
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
          .select('id, total_amount, cash_amount, payment_method, created_at, stores!inner(tenant_id, name)')
          .gte('created_at', from).lt('created_at', to).order('id')
        salesQuery = scopeQuery(salesQuery, ctx)

        // Expenses for today. Soft-deleted rows are excluded, otherwise a
        // deleted expense would keep reducing the profit KPI.
        let expensesQuery = supabase
          .from('expenses')
          .select('id, amount, description, category, created_at, deleted_at, stores!inner(tenant_id)')
          .gte('created_at', from).lt('created_at', to).is('deleted_at', null).order('id')
        expensesQuery = scopeQuery(expensesQuery, ctx)

        // The alert threshold is configured per store, not hardcoded.
        let limit = 10
        if (ctx.storeId) {
          const store = await supabase.from('stores').select('low_stock_alert').eq('id', ctx.storeId).single()
          if (Number.isFinite(Number(store.data?.low_stock_alert))) limit = Number(store.data.low_stock_alert)
        }
        // `count: 'exact'` still reports the true total while `.limit` caps the
        // rows we ship for the detail list.
        let inventoryQuery = supabase
          .from('inventory')
          .select('id, quantity, stores!inner(tenant_id, name), product_variants!inner(color, size, products!inner(name))', { count: 'exact' })
          .lte('quantity', limit)
          .limit(200)
        inventoryQuery = scopeQuery(inventoryQuery, ctx)

        let itemsQuery = supabase
          .from('sale_items')
          .select('id, quantity, final_price, product_variants!inner(cost_price_avg, products!inner(tenant_id, name)), sales!inner(store_id, created_at, stores!inner(tenant_id))')
          .gte('sales.created_at', from).lt('sales.created_at', to).eq('product_variants.products.tenant_id', ctx.tenantId).order('id')
        itemsQuery = scopeQuery(itemsQuery, ctx, 'sales.store_id', 'sales.stores.tenant_id')

        // Opening cash: an open shift already carries what was counted in the
        // drawer at open, so this is read, never derived from a previous close.
        let shiftQuery = supabase
          .from('shifts')
          .select('id, expected_cash, start_time, total_credit_payments, total_collections, total_employee_payments, stores!inner(tenant_id)')
          .eq('status', 'open')
          .order('start_time', { ascending: false })
        shiftQuery = scopeQuery(shiftQuery, ctx)

        const [sales, expenses, inventoryResult, items, creditTotal, shifts] = await Promise.all([
          fetchAllRows(salesQuery),
          fetchAllRows(expensesQuery),
          inventoryQuery,
          fetchAllRows(itemsQuery),
          supabase.rpc('engine_total_credit', { p_store: ctx.allBranches ? null : ctx.storeId }),
          shiftQuery,
        ])
        if (inventoryResult.error) throw inventoryResult.error
        if (creditTotal.error) console.error('[dashboard] total credit failed', creditTotal.error)
        if (shifts.error) console.error('[dashboard] open shift read failed', shifts.error)
        if (cancelled) return

        const rows = sales || []
        const expenseRows = expenses || []
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

        const expenseTotal = expenseRows.reduce((s, r) => s + Number(r.amount || 0), 0)

        // Several branches can each have an open shift; "all branches" adds the
        // floats, a single branch reads its own. Aggregating the extra columns
        // keeps the breakdown consistent with whichever scope is shown.
        const shiftRows = shifts.data || []
        const opening = shiftRows.reduce((s, r) => s + Number(r.expected_cash || 0), 0)
        const creditPayments = shiftRows.reduce((s, r) => s + Number(r.total_credit_payments || 0), 0)
        const collections = shiftRows.reduce((s, r) => s + Number(r.total_collections || 0), 0)
        const employeePayments = shiftRows.reduce((s, r) => s + Number(r.total_employee_payments || 0), 0)

        setStats({
          cash,
          sales: totalSales,
          invoices,
          average,
          profit,
          expenses: expenseTotal,
          credit: Number(creditTotal.data || 0),
          alerts: inventoryResult.count || 0,
          opening,
          creditPayments,
          collections,
          employeePayments,
          checkedAt: currentTimeLabel(),
          shiftOpen: shiftRows.length > 0,
          saleRows: rows.map(row => ({
            key: row.id,
            store: row.stores?.name || '—',
            method: paymentLabel(row),
            total: formatDzd(row.total_amount),
          })),
          expenseRows: expenseRows.map(row => ({
            key: row.id,
            description: row.description || '—',
            category: row.category || '—',
            amount: formatDzd(row.amount),
          })),
          // Derived after the fact from the item rows, so the modal shows the
          // same arithmetic the KPI does rather than a second, separate query.
          profitRows: (items || []).slice(0, 200).map(item => {
            const qty = Number(item.quantity || 0)
            const price = Number(item.final_price || 0)
            const cost = Number(item.product_variants?.cost_price_avg || 0)
            return {
              key: item.id,
              product: item.product_variants?.products?.name || '—',
              quantity: String(qty),
              unit: formatDzd((price - cost) * qty),
            }
          }),
          alertRows: (inventoryResult.data || []).map(row => ({
            key: row.id,
            product: [row.product_variants?.products?.name, row.product_variants?.color, row.product_variants?.size]
              .filter(Boolean).join(' · ') || '—',
            store: row.stores?.name || '—',
            quantity: String(row.quantity ?? 0),
          })),
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

  const openCash = () => setDetail({
    title: 'النقد في الصندوق',
    subtitle: stats.shiftOpen
      ? 'تفصيل اليوم: الافتتاحي ثم المقبوضات ثم المصاريف'
      : 'لا توجد وردية مفتوحة اليوم، لذلك لا يوجد رصيد افتتاحي',
    total: formatDzd(drawerTotal(cashLines(stats))),
    breakdown: cashLines(stats),
  })

  const openSales = () => setDetail({
    title: 'مبيعات اليوم',
    subtitle: `${stats.invoices} فاتورة · متوسط الفاتورة ${formatDzd(stats.average)}`,
    total: formatDzd(stats.sales),
    columns: [
      { key: 'store', label: 'الفرع' },
      { key: 'method', label: 'طريقة الدفع' },
      { key: 'total', label: 'المبلغ' },
    ],
    rows: stats.saleRows,
    empty: 'لا توجد مبيعات مسجلة اليوم',
  })

  const openProfit = () => setDetail({
    title: 'الربح المحسوب',
    subtitle: 'صافي (السعر النهائي − التكلفة) × الكمية',
    total: formatDzd(stats.profit),
    columns: [
      { key: 'product', label: 'المنتج' },
      { key: 'quantity', label: 'الكمية' },
      { key: 'unit', label: 'هامش البند' },
    ],
    rows: stats.profitRows,
    empty: 'لا توجد بنود مبيعات اليوم',
  })

  const openExpenses = () => setDetail({
    title: 'مصاريف اليوم',
    subtitle: `${stats.expenseRows.length} مصروفاً مسجلاً اليوم`,
    total: formatDzd(stats.expenses),
    columns: [
      { key: 'description', label: 'البيان' },
      { key: 'category', label: 'التصنيف' },
      { key: 'amount', label: 'المبلغ' },
    ],
    rows: stats.expenseRows,
    empty: 'لا توجد مصاريف مسجلة اليوم',
  })

  const openAlerts = () => setDetail({
    title: 'تنبيهات المخزون',
    subtitle: `آخر فحص: ${stats.checkedAt}`,
    total: `${stats.alerts} منتجاً منخفضاً`,
    columns: [
      { key: 'product', label: 'المنتج' },
      { key: 'store', label: 'الفرع' },
      { key: 'quantity', label: 'المتوفر' },
    ],
    rows: stats.alertRows,
    empty: 'كل المنتجات فوق حد التنبيه',
  })

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
            subtitle="اضغط لعرض تفصيل الصندوق اليوم"
            icon={IconCash}
            onClick={openCash}
          />
          <KpiCard
            title="مبيعات اليوم"
            value={formatDzd(stats.sales)}
            subtitle={`عدد الفواتير: ${stats.invoices} | متوسط الفاتورة: ${formatDzd(stats.average)}`}
            icon={IconSales}
            onClick={openSales}
          />
          <KpiCard
            title="الربح المحسوب"
            value={formatDzd(stats.profit)}
            subtitle="(السعر النهائي − سعر التكلفة) × الكمية"
            icon={IconProfit}
            onClick={openProfit}
          />
          <KpiCard
            title="مصاريف اليوم"
            value={formatDzd(stats.expenses)}
            subtitle={`${stats.expenseRows.length} مصروفاً اليوم`}
            icon={IconExpenses}
            accent="red"
            onClick={openExpenses}
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
            onClick={openAlerts}
          />
        </div>

        <SalesChart />
      </div>
      <KpiModal detail={detail} onClose={() => setDetail(null)} />
    </DashboardShell>
  )
}

// The vertical drawer breakdown. Opening float, today's cash sales, then every
// movement the close-shift formula subtracts or adds.
function cashLines(stats) {
  const lines = [
    { label: 'الرصيد الافتتاحي', amount: stats.opening },
    { label: 'مبيعات نقدية اليوم', amount: stats.cash },
    { label: 'مصاريف اليوم', amount: -stats.expenses },
  ]
  if (stats.creditPayments) lines.push({ label: 'تسديدات الكريدي نقداً', amount: stats.creditPayments })
  if (stats.collections) lines.push({ label: 'تحصيلات الشيكات', amount: stats.collections })
  if (stats.employeePayments) lines.push({ label: 'سلف ومدفوعات الموظفين', amount: -stats.employeePayments })
  return lines
}
