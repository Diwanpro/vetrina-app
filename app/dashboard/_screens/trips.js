'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Notice, fieldClass, primaryClass, secondaryClass } from '@/components/dashboard/EngineUI'
import CustomSelect from '@/components/ui/CustomSelect'
import { supabase } from '@/lib/supabase'
import { formatDzd, getAppContext } from '@/lib/app-context'
import { tripTotals } from '@/lib/trips'

// A journey to the supplier. The goods cost what they cost; getting there costs
// something too, and that second number is a cost of the goods, not a shop
// expense. Neither the form nor the RPC ever writes to `expenses`, because
// `expenses` is the cash drawer's ledger and a minibus fare never touched it.

const DEFAULT_EXPENSES = ['نقل', 'طعام', 'موقف السيارات', 'تحميل وتنزيل']

function todayInput() {
  const now = new Date()
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
}

function money(value) {
  const n = Number(value)
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : 0
}

export default function TripsPage() {
  const [ctx, setCtx] = useState(null)
  const [products, setProducts] = useState([])
  const [suppliers, setSuppliers] = useState([])
  const [trips, setTrips] = useState([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')

  const [supplierId, setSupplierId] = useState('')
  const [tripDate, setTripDate] = useState(todayInput())
  const [notes, setNotes] = useState('')
  const [items, setItems] = useState([])
  const [expenses, setExpenses] = useState([{ label: 'نقل', amount: '' }])
  const [search, setSearch] = useState('')
  const [pickedVariant, setPickedVariant] = useState('')
  const [pickQty, setPickQty] = useState('1')
  const [pickCost, setPickCost] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const context = await getAppContext()
      setCtx(context)
      // Products and their variants in one round trip; the search box filters
      // variants, so a size is what actually gets added to the trip.
      const { data: productRows, error: pErr } = await supabase
        .from('products')
        .select('id, name, base_price, product_variants(id, color, size, cost_price_avg)')
        .eq('tenant_id', context.tenantId).eq('is_active', true).order('name')
      if (pErr) throw pErr
      setProducts(productRows || [])

      const { data: supplierRows, error: sErr } = await supabase
        .from('suppliers').select('id, name').eq('tenant_id', context.tenantId).order('name')
      if (sErr) throw sErr
      setSuppliers(supplierRows || [])

      if (context.storeId) {
        const { data: tripRows, error: tErr } = await supabase
          .from('shopping_trips')
          .select('id, trip_date, supplier_name, goods_cost, trip_expenses, total_units, cost_per_unit, created_at, shopping_trip_expenses(label, amount)')
          .eq('store_id', context.storeId).order('trip_date', { ascending: false }).limit(20)
        if (tErr) throw tErr
        setTrips(tripRows || [])
      }
    } catch (err) {
      console.error('[trips] load failed', err)
      setError(err.message || 'تعذر تحميل بيانات الرحلات')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  const variants = useMemo(() => products.flatMap(product =>
    (product.product_variants || []).map(variant => ({
      id: variant.id,
      label: [product.name, variant.color, variant.size].filter(Boolean).join(' · '),
      name: product.name,
      cost: Number(variant.cost_price_avg || 0),
    }))
  ), [products])

  const matches = useMemo(() => {
    const term = search.trim()
    if (!term) return variants.slice(0, 30)
    return variants.filter(row => row.label.includes(term)).slice(0, 30)
  }, [variants, search])

  const picked = variants.find(row => row.id === pickedVariant) || null

  // Choosing a variant pre-fills the last known cost, which is the number the
  // owner is most likely to keep.
  useEffect(() => {
    if (picked) setPickCost(String(picked.cost))
  }, [pickedVariant]) // eslint-disable-line react-hooks/exhaustive-deps

  // One implementation, shared with the tests, so the preview and the RPC
  // cannot drift apart.
  const { goods: goodsTotal, units: unitsTotal, extras: expensesTotal, spread } = tripTotals(items, expenses)

  const addItem = () => {
    if (!picked) return setError('اختر منتجاً ومقاساً أولاً')
    const quantity = Math.floor(Number(pickQty))
    const unitCost = Math.floor(Number(pickCost))
    if (!Number.isFinite(quantity) || quantity <= 0) return setError('أدخل كمية صحيحة أكبر من صفر')
    if (!Number.isFinite(unitCost) || unitCost < 0) return setError('أدخل سعر شراء صحيحاً')
    if (items.some(row => row.variant_id === picked.id)) return setError('هذا المقاس مضاف بالفعل إلى الرحلة')
    setError('')
    setItems([...items, {
      variant_id: picked.id, label: picked.label, quantity, unit_cost: unitCost,
    }])
    setPickedVariant('')
    setPickQty('1')
    setPickCost('')
    setSearch('')
  }

  const save = async (event) => {
    event.preventDefault()
    if (busy) return
    setError('')
    setSuccess('')
    if (!items.length) return setError('أضف منتجاً واحداً على الأقل إلى الرحلة')
    if (!ctx?.storeId) return setError('اختر فرعاً محدداً قبل حفظ الرحلة')

    setBusy(true)
    try {
      const cleanExpenses = expenses
        .filter(row => money(row.amount) > 0)
        .map(row => ({ label: row.label.trim() || 'مصروف رحلة', amount: money(row.amount) }))

      const { data, error: rpcError } = await supabase.rpc('engine_save_trip', {
        p_store: ctx.storeId,
        p_tenant: ctx.tenantId,
        p_supplier: supplierId || null,
        p_trip_date: tripDate || null,
        p_items: items.map(row => ({
          variant_id: row.variant_id, quantity: row.quantity, unit_cost: row.unit_cost,
        })),
        p_expenses: cleanExpenses,
        p_request: crypto.randomUUID(),
        p_notes: notes.trim() || null,
      })
      if (rpcError) throw rpcError

      setSuccess(
        `تم حفظ الرحلة${data ? '' : ''} — أُضيف ${formatDzd(spread)} إلى تكلفة كل قطعة (${unitsTotal} قطعة).`
      )
      setItems([])
      setExpenses([{ label: 'نقل', amount: '' }])
      setSupplierId('')
      setNotes('')
      setTripDate(todayInput())
      await load()
    } catch (err) {
      console.error('[trips] save failed', err)
      setError(err.message || 'تعذر حفظ الرحلة')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-white/5 bg-card p-4">
        <h1 className="text-lg font-bold text-gold">رحلات الشراء</h1>
        <p className="mt-1 text-sm leading-6 text-neutral-400">
          اجمع مشتريات الرحلة ومصاريفها في مكان واحد. مصاريف الرحلة تُوزَّع على كل قطعة
          وتُضاف إلى تكلفتها الحقيقية، ولا تُسجَّل كمصروف في الصندوق لأنها لم تخرج من درج المحل.
        </p>
      </div>

      {loading ? <p role="status" className="text-sm text-neutral-400">جاري تحميل الرحلات...</p> : null}
      <Notice error={error} success={success} />

      <form onSubmit={save} className="space-y-4">
        <section className="rounded-xl border border-white/5 bg-card p-4">
          <h2 className="mb-3 text-sm font-medium text-gold">بيانات الرحلة</h2>
          <div className="grid gap-3 sm:grid-cols-3">
            <label className="block text-xs text-neutral-400">
              المورد (اختياري)
              <CustomSelect
                className="mt-1"
                value={supplierId}
                onChange={setSupplierId}
                placeholder="بدون مورد"
                options={[{ label: 'بدون مورد', value: '' },
                  ...suppliers.map(row => ({ label: row.name, value: row.id }))]}
              />
            </label>
            <label className="block text-xs text-neutral-400">
              تاريخ الرحلة
              <input type="date" className={`mt-1 ${fieldClass}`} value={tripDate}
                onChange={event => setTripDate(event.target.value)} />
            </label>
            <label className="block text-xs text-neutral-400">
              ملاحظات
              <input className={`mt-1 ${fieldClass}`} value={notes} placeholder="اختياري"
                onChange={event => setNotes(event.target.value)} />
            </label>
          </div>
        </section>

        <section className="rounded-xl border border-white/5 bg-card p-4">
          <h2 className="mb-3 text-sm font-medium text-gold">المنتجات المشتراة</h2>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block text-xs text-neutral-400">
              بحث في المخزون
              <input className={`mt-1 ${fieldClass}`} value={search} placeholder="اسم المنتج أو المقاس"
                onChange={event => setSearch(event.target.value)} />
            </label>
            <label className="block text-xs text-neutral-400">
              المقاس
              <CustomSelect
                className="mt-1"
                value={pickedVariant}
                onChange={setPickedVariant}
                placeholder={matches.length ? 'اختر المقاس' : 'لا نتائج'}
                options={matches.map(row => ({ label: row.label, value: row.id }))}
              />
            </label>
          </div>
          <div className="mt-3 grid gap-2 sm:grid-cols-3">
            <label className="block text-xs text-neutral-400">
              الكمية
              <input type="number" min="1" step="1" className={`mt-1 ${fieldClass}`} value={pickQty}
                onChange={event => setPickQty(event.target.value)} />
            </label>
            <label className="block text-xs text-neutral-400">
              سعر الشراء للوحدة
              <input type="number" min="0" step="1" className={`mt-1 ${fieldClass}`} value={pickCost}
                onChange={event => setPickCost(event.target.value)} />
            </label>
            <div className="flex items-end">
              <button type="button" onClick={addItem} className={`${secondaryClass} w-full`}>إضافة إلى الرحلة</button>
            </div>
          </div>

          {items.length ? (
            <div className="mt-3 overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-white/10 text-xs text-neutral-500">
                    <th className="p-2 text-right font-normal">المنتج</th>
                    <th className="p-2 text-right font-normal">الكمية</th>
                    <th className="p-2 text-right font-normal">سعر الوحدة</th>
                    <th className="p-2 text-right font-normal">الإجمالي</th>
                    <th className="p-2" />
                  </tr>
                </thead>
                <tbody>
                  {items.map(row => (
                    <tr key={row.variant_id} className="border-b border-white/5 last:border-0">
                      <td className="p-2 text-neutral-200">{row.label}</td>
                      <td className="p-2 tabular-nums text-neutral-300">{row.quantity}</td>
                      <td className="p-2 tabular-nums text-neutral-300">{formatDzd(row.unit_cost)}</td>
                      <td className="p-2 tabular-nums text-neutral-300">{formatDzd(row.quantity * row.unit_cost)}</td>
                      <td className="p-2 text-left">
                        <button type="button" className="text-xs text-red-300"
                          onClick={() => setItems(items.filter(item => item.variant_id !== row.variant_id))}>
                          حذف
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : <p className="mt-3 text-xs text-neutral-500">لم تُضف أي قطعة بعد.</p>}
        </section>

        <section className="rounded-xl border border-white/5 bg-card p-4">
          <h2 className="mb-1 text-sm font-medium text-gold">مصاريف الرحلة</h2>
          <p className="mb-3 text-xs text-neutral-500">
            تُوزَّع بالتساوي على كل قطعة في الرحلة وتُضاف إلى تكلفتها. لا تُخصم من الصندوق.
          </p>
          <div className="space-y-2">
            {expenses.map((row, index) => (
              <div key={index} className="grid gap-2 sm:grid-cols-[2fr_1fr_auto]">
                <CustomSelect
                  value={row.label}
                  onChange={label => setExpenses(expenses.map((entry, i) => i === index ? { ...entry, label } : entry))}
                  options={DEFAULT_EXPENSES.map(label => ({ label, value: label }))}
                />
                <input type="number" min="0" step="1" placeholder="المبلغ" className={fieldClass}
                  value={row.amount}
                  onChange={event => setExpenses(expenses.map((entry, i) => i === index ? { ...entry, amount: event.target.value } : entry))} />
                <button type="button" className={secondaryClass}
                  onClick={() => setExpenses(expenses.filter((_, i) => i !== index))}>حذف</button>
              </div>
            ))}
          </div>
          <button type="button" className={`${secondaryClass} mt-2`}
            onClick={() => setExpenses([...expenses, { label: DEFAULT_EXPENSES[0], amount: '' }])}>
            إضافة مصروف
          </button>
        </section>

        <section className="rounded-xl border border-gold/20 bg-gold/5 p-4">
          <h2 className="mb-3 text-sm font-medium text-gold">ملخص الرحلة</h2>
          <dl className="grid gap-2 text-sm sm:grid-cols-2">
            <div className="flex justify-between gap-3"><dt className="text-neutral-400">قيمة البضاعة</dt><dd className="tabular-nums">{formatDzd(goodsTotal)}</dd></div>
            <div className="flex justify-between gap-3"><dt className="text-neutral-400">مصاريف الرحلة</dt><dd className="tabular-nums">{formatDzd(expensesTotal)}</dd></div>
            <div className="flex justify-between gap-3"><dt className="text-neutral-400">عدد القطع</dt><dd className="tabular-nums">{unitsTotal}</dd></div>
            <div className="flex justify-between gap-3"><dt className="text-neutral-400">نصيب القطعة من المصاريف</dt><dd className="tabular-nums text-gold">{formatDzd(spread)}</dd></div>
          </dl>
          <p className="mt-2 text-xs leading-6 text-neutral-400">
            التكلفة الحقيقية للقطعة = سعر الشراء + {formatDzd(spread)} من مصاريف الرحلة.
          </p>
          <button type="submit" disabled={busy || !ctx?.storeId} className={`${primaryClass} mt-3 w-full sm:w-auto`}>
            {busy ? 'جاري الحفظ...' : 'حفظ الرحلة'}
          </button>
          {!ctx?.storeId && !loading ? (
            <p className="mt-2 text-xs text-amber-300">اختر فرعاً محدداً من الأعلى لحفظ الرحلة.</p>
          ) : null}
        </section>
      </form>

      <section className="rounded-xl border border-white/5 bg-card p-4">
        <h2 className="mb-3 text-sm font-medium text-gold">سجل الرحلات</h2>
        {trips.length === 0 ? <p className="text-sm text-neutral-500">لا توجد رحلات مسجلة لهذا الفرع.</p> : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-white/10 text-xs text-neutral-500">
                  <th className="p-2 text-right font-normal">التاريخ</th>
                  <th className="p-2 text-right font-normal">المورد</th>
                  <th className="p-2 text-right font-normal">البضاعة</th>
                  <th className="p-2 text-right font-normal">مصاريف الرحلة</th>
                  <th className="p-2 text-right font-normal">نصيب القطعة</th>
                </tr>
              </thead>
              <tbody>
                {trips.map(trip => (
                  <tr key={trip.id} className="border-b border-white/5 last:border-0">
                    <td className="p-2 text-neutral-300">{trip.trip_date}</td>
                    <td className="p-2 text-neutral-300">{trip.supplier_name || '—'}</td>
                    <td className="p-2 tabular-nums text-neutral-300">{formatDzd(trip.goods_cost)}</td>
                    <td className="p-2 tabular-nums text-neutral-300">{formatDzd(trip.trip_expenses)}</td>
                    <td className="p-2 tabular-nums text-gold">{formatDzd(trip.cost_per_unit)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  )
}
