'use client'

import { useEffect, useState } from 'react'
import DashboardShell from '@/components/dashboard/DashboardShell'
import ActivationForm from '@/components/dashboard/ActivationForm'
import { useDashboardSession } from '@/components/dashboard/SessionProvider'
import { Notice, fieldClass, primaryClass, secondaryClass } from '@/components/dashboard/EngineUI'
import { supabase } from '@/lib/supabase'
import { scopeQuery, csvText } from '@/lib/access'
import { fetchAllRows } from '@/lib/cash'
import { localRows, pendingRows } from '@/lib/local-db'
import { syncPending } from '@/lib/sync'
import { formatDzd } from '@/lib/app-context'

function download(name, text, type = 'text/csv;charset=utf-8') {
  const url = URL.createObjectURL(new Blob([text], { type }))
  const link = document.createElement('a'); link.href = url; link.download = name; link.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
export default function SettingsPage() {
  const ctx = useDashboardSession()
  const [rows, setRows] = useState([])
  const [name, setName] = useState('')
  const [address, setAddress] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    const refresh = () => pendingRows(ctx).then(setRows).catch(err => setError(err.message))
    refresh(); window.addEventListener('vetrina:outbox', refresh)
    return () => window.removeEventListener('vetrina:outbox', refresh)
  }, [ctx])
  async function run(action) {
    if (busy) return
    setBusy(true); setError('')
    try { await action() } catch (err) { setError(err.message) } finally { setBusy(false) }
  }
  async function exportData(type) {
    if (!navigator.onLine) throw new Error('تصدير بيانات الخادم يتطلب الاتصال. يمكنك تصدير الفواتير المحلية أدناه.')
    if (!['owner', 'manager'].includes(ctx.role)) throw new Error('غير مصرح بالتصدير')
    if (type === 'sales') {
      const data = await fetchAllRows(scopeQuery(supabase.from('sales').select('id, store_id, created_at, total_amount, payment_method, status, local_id, synced_at, stores!inner(tenant_id)').order('id'), ctx))
      download('vetrina-sales.csv', csvText([
        { key: 'id', label: 'رقم الفاتورة' }, { key: 'store_id', label: 'الفرع' }, { key: 'created_at', label: 'التاريخ' }, { key: 'total_amount', label: 'الإجمالي' }, { key: 'payment_method', label: 'طريقة الدفع' }, { key: 'status', label: 'الحالة' }, { key: 'local_id', label: 'المعرّف المحلي' }, { key: 'synced_at', label: 'المزامنة' },
      ], data))
    } else {
      const query = supabase.from('products').select('id, name, description, base_price, product_variants!inner(id, color, size, barcode, cost_price_avg, inventory!inner(store_id, quantity, stores!inner(tenant_id)))').eq('tenant_id', ctx.tenantId).order('id')
      const data = await fetchAllRows(scopeQuery(query, ctx, 'product_variants.inventory.store_id', 'product_variants.inventory.stores.tenant_id'))
      const flat = data.flatMap(product => product.product_variants.flatMap(variant => variant.inventory.map(stock => ({
        name: product.name, description: product.description, price: product.base_price, color: variant.color, size: variant.size, barcode: variant.barcode, cost: variant.cost_price_avg, store_id: stock.store_id, quantity: stock.quantity,
      }))))
      download('vetrina-products.csv', csvText([
        { key: 'name', label: 'المنتج' }, { key: 'description', label: 'الوصف' }, { key: 'color', label: 'اللون' }, { key: 'size', label: 'المقاس' }, { key: 'barcode', label: 'الباركود' }, { key: 'price', label: 'سعر البيع' }, { key: 'cost', label: 'متوسط التكلفة' }, { key: 'store_id', label: 'الفرع' }, { key: 'quantity', label: 'المخزون' },
      ], flat))
    }
  }
  return <DashboardShell active="/dashboard/settings"><div className="mx-auto max-w-4xl space-y-5">
    <h1 className="text-xl text-neutral-100">الإعدادات</h1><Notice error={error} />
    <section className="rounded-2xl border border-gold/20 bg-card p-5"><h2 className="mb-3 text-gold">الاشتراك والتفعيل</h2><p className="mb-4 text-sm text-neutral-400">{ctx.tenant.name} · {ctx.tenant.is_active ? 'الحساب نشط' : 'فترة تجريبية'}{ctx.tenant.subscription_end_date && ` · نهاية الاشتراك: ${new Date(ctx.tenant.subscription_end_date).toLocaleDateString('ar-DZ')}`}</p>{ctx.role === 'owner' ? <ActivationForm onActivated={() => location.reload()} /> : <p className="text-sm text-neutral-500">إدارة الاشتراك متاحة للمالك فقط.</p>}</section>
    {ctx.role === 'owner' && <section className="rounded-2xl border border-white/10 bg-card p-5"><h2 className="mb-3 text-gold">الفروع · {ctx.stores.length} فرع</h2><p className="mb-4 text-xs text-neutral-500">يمكن إضافة عدد غير محدود من الفروع للمؤسسة.</p><div className="mb-4 flex flex-wrap gap-2">{ctx.stores.map(store => <span key={store.id} className="rounded-lg bg-white/5 px-3 py-2 text-sm text-neutral-300">{store.name}</span>)}</div>
      <form onSubmit={event => { event.preventDefault(); run(async () => {
        if (!navigator.onLine) throw new Error('إضافة فرع تتطلب الاتصال')
        const { error } = await supabase.rpc('engine_add_store', { p_name: name, p_address: address }); if (error) throw error
        location.reload()
      }) }} className="grid gap-3 sm:grid-cols-2"><label className="text-sm text-neutral-300">اسم الفرع<input required maxLength={200} disabled={busy} value={name} onChange={e => setName(e.target.value)} className={`${fieldClass} mt-1`} /></label><label className="text-sm text-neutral-300">العنوان<input disabled={busy} value={address} onChange={e => setAddress(e.target.value)} className={`${fieldClass} mt-1`} /></label><button disabled={busy} className={primaryClass}>إضافة فرع</button></form>
    </section>}
    {ctx.role !== 'employee' && <section className="rounded-2xl border border-white/10 bg-card p-5"><h2 className="mb-3 text-gold">تصدير البيانات</h2><p className="mb-4 text-xs text-neutral-500">ملفات CSV بترميز UTF-8 حسب الفرع المحدد (أو كل فروع المؤسسة للمالك). المبيعات المصدّرة هنا هي المتزامنة فقط.</p><div className="flex flex-wrap gap-3"><button disabled={busy} onClick={() => run(() => exportData('sales'))} className={secondaryClass}>تصدير المبيعات CSV</button><button disabled={busy} onClick={() => run(() => exportData('products'))} className={secondaryClass}>تصدير المنتجات CSV</button></div></section>}
    <section className="rounded-2xl border border-white/10 bg-card p-5"><h2 className="mb-3 text-gold">المزامنة والفواتير المحلية · {rows.length}</h2><p className="mb-4 text-xs text-neutral-500">لا تُحذف العمليات المتعارضة تلقائياً. صحّح المخزون أو السعر ثم أعد المحاولة. الفواتير محفوظة على هذا الجهاز ولهذا المستخدم فقط.</p>
      <div className="mb-4 flex flex-wrap gap-3"><button disabled={busy} onClick={() => run(syncPending)} className={primaryClass}>إعادة محاولة المزامنة</button><button disabled={busy || !rows.length} onClick={() => download('vetrina-pending-receipts.json', JSON.stringify(rows, null, 2), 'application/json')} className={secondaryClass}>نسخة من العمليات المحلية JSON</button></div>
      <div className="space-y-2">{rows.map(row => <article key={row.local_id} className="rounded-lg border border-white/5 p-3 text-xs text-neutral-300"><p>{row.kind === 'audit' ? 'سجل تدقيق' : `فاتورة · ${formatDzd(row.total_amount)}`} · {new Date(row.created_at).toLocaleString('ar-DZ')}</p><p className="mt-1 text-neutral-500">{ctx.stores.find(store => store.id === row.store_id)?.name} · {row.local_id}</p><p className="mt-1 text-amber-300">{row.error || 'بانتظار الاتصال والمزامنة'}</p></article>)}</div>
    </section>
    <button disabled={busy} onClick={() => run(async () => {
      const pending = (await localRows()).filter(row => row.auth_id === ctx.user.id && row.status !== 'synced')
      if (pending.length && !confirm('لديك عمليات غير متزامنة محفوظة لهذا المستخدم. ستظل على الجهاز ولن تتم مزامنتها إلا بعد عودتك لهذا الحساب. تسجيل الخروج؟')) return
      const { error } = await supabase.auth.signOut({ scope: 'local' }); if (error) throw error
      localStorage.removeItem('vetrina.auth'); location.assign('/login')
    })} className="rounded-lg border border-red-800/40 px-4 py-2 text-sm text-red-300">تسجيل الخروج</button>
  </div></DashboardShell>
}
