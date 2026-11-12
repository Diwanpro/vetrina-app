'use client'

import { useEffect, useState } from 'react'
import ActivationForm from '@/components/dashboard/ActivationForm'
import { useDashboardSession } from '@/components/dashboard/SessionProvider'
import { Notice, fieldClass, primaryClass, secondaryClass } from '@/components/dashboard/EngineUI'
import CustomSelect from '@/components/ui/CustomSelect'
import { supabase } from '@/lib/supabase'
import { canAddBranch } from '@/lib/commercial'
import { scopeQuery, csvText } from '@/lib/access'
import { describeDevice } from '@/lib/device'
import { deactivateCurrentDevice, deactivateSession, listSessions, sortSessions } from '@/lib/sessions'
import { fetchAllRows } from '@/lib/cash'
import { localRows, pendingRows } from '@/lib/local-db'
import { syncPending } from '@/lib/sync'
import { formatDzd } from '@/lib/app-context'
import { WILAYAS } from '@/lib/wilayas'

// --- STORE SETTINGS TAB CONSTANTS ---
const RETURN_POLICY_OPTIONS = [
  { label: '7 أيام', value: '7' },
  { label: '14 يوماً', value: '14' },
  { label: '30 يوماً', value: '30' },
  { label: '60 يوماً', value: '60' },
  { label: '90 يوماً', value: '90' },
  { label: 'لا يوجد', value: '0' },
]

function download(name, text, type = 'text/csv;charset=utf-8') {
  const url = URL.createObjectURL(new Blob([text], { type }))
  const link = document.createElement('a'); link.href = url; link.download = name; link.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export default function SettingsPage() {
  const ctx = useDashboardSession()
  
  // --- STORE SETTINGS TAB STATE ---
  const [storeSettings, setStoreSettings] = useState({
    name: '', address: '', phone: '', google_maps_url: '',
    receipt_footer: '', tax_rc: '', logo_on_receipt: false, prices_on_receipt: false,
    return_policy_days: '7', low_stock_alert: 10,
    enable_barcode: true, logo_url: ''
  })
  const [logoFile, setLogoFile] = useState(null)
  const [settingsBusy, setSettingsBusy] = useState(false)
  const [settingsError, setSettingsError] = useState('')
  const [settingsSuccess, setSettingsSuccess] = useState('')
  // Wilaya code -> price, kept as strings while the owner is typing.
  const [deliveryRates, setDeliveryRates] = useState({})
  const [ratesBusy, setRatesBusy] = useState(false)
  
  // --- EXISTING STATE ---
  const [rows, setRows] = useState([])
  const [name, setName] = useState('')
  const [address, setAddress] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [sessions, setSessions] = useState([])
  const [myFingerprint, setMyFingerprint] = useState('')
  const [sessionNotice, setSessionNotice] = useState('')
  const [costReport, setCostReport] = useState(null)
  
  // --- STORE SETTINGS LOGIC ---
  async function loadStoreSettings() {
    if (!ctx?.storeId) return
    try {
      const { data, error } = await supabase.from('stores').select('name, address, phone, google_maps_url, receipt_footer, tax_rc, logo_on_receipt, prices_on_receipt, return_policy_days, low_stock_alert, enable_barcode, logo_url, delivery_rates').eq('id', ctx.storeId).single()
      if (error) throw error
      if (data) {
        setDeliveryRates(Object.fromEntries(
          Object.entries(data.delivery_rates || {}).map(([code, value]) => [code, String(value)])
        ))
        setStoreSettings({
          name: data.name || '',
          address: data.address || '',
          phone: data.phone || '',
          google_maps_url: data.google_maps_url || '',
          receipt_footer: data.receipt_footer || '',
          tax_rc: data.tax_rc || '',
          logo_on_receipt: data.logo_on_receipt ?? false,
          prices_on_receipt: data.prices_on_receipt ?? false,
          return_policy_days: data.return_policy_days?.toString() || '7',
          low_stock_alert: data.low_stock_alert ?? 10,
          enable_barcode: data.enable_barcode ?? true,
          logo_url: data.logo_url || ''
        })
      }
    } catch (err) { setSettingsError(err.message) }
  }

  async function saveStoreSettings() {
    if (!ctx?.storeId) return
    setSettingsBusy(true); setSettingsError(''); setSettingsSuccess('')
    try {
      // Upload Logo if file exists
      let finalLogoUrl = storeSettings.logo_url
      if (logoFile) {
        const ext = (logoFile.name.split('.').pop() || 'jpg').toLowerCase().replace(/[^a-z0-9]/g, '') || 'jpg'
        const path = `${ctx.tenantId}/${ctx.storeId}/logo-${Date.now()}.${ext}`
        const { error: upErr } = await supabase.storage.from('store-logos').upload(path, logoFile, {
          cacheControl: '3600', upsert: true, contentType: logoFile.type || 'image/jpeg'
        })
        if (upErr) throw new Error(`فشل رفع الشعار: ${upErr.message}`)
        const { data: pub } = await supabase.storage.from('store-logos').getPublicUrl(path)
        finalLogoUrl = pub?.publicUrl || ''
      }

      const { error: rpcErr } = await supabase.rpc('engine_update_store_settings', {
        p_store: ctx.storeId,
        p_name: storeSettings.name,
        p_address: storeSettings.address,
        p_phone: storeSettings.phone,
        p_google_maps_url: storeSettings.google_maps_url,
        p_receipt_footer: storeSettings.receipt_footer,
        p_tax_rc: storeSettings.tax_rc,
        p_logo_on_receipt: storeSettings.logo_on_receipt,
        p_prices_on_receipt: storeSettings.prices_on_receipt,
        p_return_policy_days: Number(storeSettings.return_policy_days),
        p_low_stock_alert: Number(storeSettings.low_stock_alert),
        p_enable_barcode: storeSettings.enable_barcode,
        p_logo_url: finalLogoUrl
      })
      
      if (rpcErr) {
        throw rpcErr
      }

      setSettingsSuccess('تم حفظ إعدادات المحل')
      loadStoreSettings()
    } catch (err) {
      setSettingsError(`خطأ: ${err.message}`)
    } finally {
      setSettingsBusy(false)
    }
  }

  // Rebuilds cost averages from real purchase receipts. Dry run first so the
  // owner sees what would change before any money field is rewritten.
  async function repairCosts(apply) {
    setBusy(true); setError('')
    try {
      const { data, error } = await supabase.rpc('engine_repair_cost_price_avg', { p_apply: apply })
      if (error) throw error
      setCostReport(data)
    } catch (err) { setError(err.message) } finally { setBusy(false) }
  }
  async function refreshSessions() {
    if (!ctx?.user?.id) return
    try {
      const rows = await listSessions(supabase, ctx.user.id)
      setSessions(sortSessions(rows.filter(row => row.is_active)))
    } catch (err) { setError(err.message) }
  }
  useEffect(() => {
    if (!ctx?.user?.id) return
    describeDevice().then(device => setMyFingerprint(device.fingerprint)).catch(() => {})
    refreshSessions()
  }, [ctx?.user?.id])
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

  // Delivery prices are stored as {"16": 400}; empty fields are simply absent,
  // which is how a wilaya says "we do not deliver there".
  async function saveDeliveryRates() {
    if (!ctx?.storeId) return
    setRatesBusy(true); setSettingsError(''); setSettingsSuccess('')
    try {
      const payload = {}
      for (const wilaya of WILAYAS) {
        const raw = String(deliveryRates[wilaya.code] ?? '').trim()
        if (!raw) continue
        if (!/^[0-9]{1,6}$/.test(raw)) throw new Error(`سعر غير صالح لولاية ${wilaya.name}`)
        payload[wilaya.code] = Number(raw)
      }
      const { error: rpcError } = await supabase.rpc('engine_update_delivery_rates', {
        p_store: ctx.storeId,
        p_rates: payload,
      })
      if (rpcError) throw rpcError
      setSettingsSuccess('تم حفظ أسعار التوصيل')
      loadStoreSettings()
    } catch (err) {
      setSettingsError(`خطأ: ${err.message}`)
    } finally {
      setRatesBusy(false)
    }
  }

  // --- TABS ---
  const [activeTab, setActiveTab] = useState('identity') // identity, receipt, policies, system, general

  useEffect(() => {
    if (ctx?.storeId) loadStoreSettings()
  }, [ctx?.storeId])

  // Accepts pasted links with or without a scheme and rejects anything that is
  // not http(s), so a javascript: URL can never reach window.open. Only strings
  // with no scheme at all get https:// prepended — otherwise "ftp://x" would be
  // mangled into "https://ftp//x" instead of being rejected.
  function toMapUrl(raw) {
    const value = (raw || '').trim()
    if (!value) return ''
    const candidate = /^[a-z][a-z0-9+.-]*:/i.test(value) ? value : `https://${value}`
    try {
      const url = new URL(candidate)
      if (url.protocol !== 'http:' && url.protocol !== 'https:') return ''
      if (!url.hostname.includes('.')) return ''
      return url.toString()
    } catch { return '' }
  }
  const mapUrl = toMapUrl(storeSettings.google_maps_url)

  return (
    <>
      <div className="mx-auto max-w-4xl space-y-5">
        <h1 className="text-xl text-neutral-100">الإعدادات</h1>
        <Notice error={error || settingsError} success={settingsSuccess} />
        
        {/* TABS NAVIGATION */}
        <div className="flex flex-wrap gap-2 border-b border-white/10 pb-3">
          {['identity', 'delivery', 'receipt', 'policies', 'system', 'general'].map(tab => (
            <button key={tab} type="button" onClick={() => setActiveTab(tab)}
              className={`px-3 py-2 text-sm rounded-lg ${activeTab === tab ? 'bg-gold text-[#121212]' : 'text-neutral-400 hover:bg-white/5'}`}>
              {tab === 'identity' && 'إعدادات المحل'}
              {tab === 'delivery' && 'أسعار التوصيل'}
              {tab === 'receipt' && 'تخصيص الإيصال'}
              {tab === 'policies' && 'سياسات التشغيل'}
              {tab === 'system' && 'تفضيلات النظام'}
              {tab === 'general' && 'عام'}
            </button>
          ))}
        </div>

        {/* TAB 1: STORE IDENTITY */}
        {activeTab === 'identity' && (
          <section className="rounded-2xl border border-gold/20 bg-card p-5">
            <h2 className="mb-3 text-gold">إعدادات المحل · الهوية</h2>
            <div className="grid gap-4 sm:grid-cols-2">
              <label className="block text-sm text-neutral-300">اسم المحل
                <input required value={storeSettings.name} onChange={e => setStoreSettings({ ...storeSettings, name: e.target.value })} className={`${fieldClass} mt-1`} />
              </label>
              <label className="block text-sm text-neutral-300">العنوان
                <input value={storeSettings.address} onChange={e => setStoreSettings({ ...storeSettings, address: e.target.value })} className={`${fieldClass} mt-1`} />
              </label>
              <label className="block text-sm text-neutral-300">رقم الهاتف
                <input value={storeSettings.phone} onChange={e => setStoreSettings({ ...storeSettings, phone: e.target.value })} className={`${fieldClass} mt-1`} />
              </label>
              <div className="block text-sm text-neutral-300 sm:col-span-2">
                <label htmlFor="store-maps-url" className="block">رابط الموقع (Google Maps)</label>
                <div className="mt-1 flex gap-2">
                  <input
                    id="store-maps-url"
                    dir="ltr"
                    inputMode="url"
                    placeholder="https://maps.app.goo.gl/..."
                    value={storeSettings.google_maps_url}
                    onChange={e => setStoreSettings({ ...storeSettings, google_maps_url: e.target.value })}
                    className={fieldClass}
                  />
                  <button
                    type="button"
                    disabled={!mapUrl}
                    onClick={() => window.open(mapUrl, '_blank', 'noopener,noreferrer')}
                    className={`${secondaryClass} shrink-0 disabled:opacity-40`}
                  >
                    فتح الخريطة
                  </button>
                </div>
                {storeSettings.google_maps_url.trim() && !mapUrl && (
                  <span className="mt-1 block text-[11px] text-amber-300">رابط غير صالح — استخدم رابطاً يبدأ بـ https://</span>
                )}
              </div>
              <label className="block text-sm text-neutral-300">شعار المحل (صورة)
                <input type="file" accept="image/*" onChange={e => setLogoFile(e.target.files?.[0] || null)} className={`${fieldClass} mt-1`} />
                {storeSettings.logo_url && <img src={storeSettings.logo_url} alt="شعار المحل" className="mt-2 h-20 w-20 rounded-lg object-cover" />}
              </label>
            </div>
            <button disabled={settingsBusy} onClick={saveStoreSettings} className={primaryClass}>{settingsBusy ? 'جاري الحفظ...' : 'حفظ الهوية'}</button>
          </section>
        )}

        {/* TAB 2: RECEIPT CUSTOMIZATION */}
        {/* DELIVERY RATES TAB */}
        {activeTab === 'delivery' && (
          <section className="rounded-2xl border border-gold/20 bg-card p-5">
            <h2 className="mb-1 text-gold">أسعار التوصيل حسب الولاية</h2>
            <p className="mb-4 text-xs leading-relaxed text-neutral-500">
              اترك الحقل فارغاً للولايات التي لا توصّل إليها. السعر يُضاف إلى إجمالي طلب الزبون،
              ولا يُحتسب من مبيعات المحل عند التسليم.
            </p>

            <div className="max-h-[30rem] overflow-y-auto rounded-xl border border-white/10 bg-black/20 p-2">
              <div className="grid gap-1.5 sm:grid-cols-2">
                {WILAYAS.map(wilaya => (
                  <label key={wilaya.code} className="flex items-center gap-2 rounded-lg px-2 py-1 hover:bg-white/[0.03]">
                    <span className="w-6 shrink-0 text-[11px] tabular-nums text-neutral-500">{wilaya.code}</span>
                    <span className="min-w-0 flex-1 truncate text-sm text-neutral-300">{wilaya.name}</span>
                    <input
                      inputMode="numeric"
                      aria-label={`سعر التوصيل إلى ${wilaya.name}`}
                      value={deliveryRates[wilaya.code] ?? ''}
                      onChange={event => {
                        const digits = event.target.value.replace(/[^0-9]/g, '')
                        setDeliveryRates(previous => ({ ...previous, [wilaya.code]: digits }))
                      }}
                      placeholder="—"
                      className="w-20 rounded-lg border border-white/10 bg-[#1A1A1A] px-2 py-1.5 text-center text-sm tabular-nums text-neutral-100 focus:border-gold/60 focus:outline-none"
                    />
                    <span className="w-6 shrink-0 text-[11px] text-neutral-500">دج</span>
                  </label>
                ))}
              </div>
            </div>

            <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
              <p className="text-[11px] text-neutral-500">
                {Object.values(deliveryRates).filter(value => String(value).trim() !== '').length} ولاية مفعّلة من {WILAYAS.length}
              </p>
              <button disabled={ratesBusy} onClick={saveDeliveryRates} className={primaryClass}>
                {ratesBusy ? 'جاري الحفظ...' : 'حفظ أسعار التوصيل'}
              </button>
            </div>
          </section>
        )}

        {activeTab === 'receipt' && (
          <section className="rounded-2xl border border-white/10 bg-card p-5">
            <h2 className="mb-3 text-gold">تخصيص الإيصال</h2>
            <div className="grid gap-4 sm:grid-cols-2">
              <label className="block text-sm text-neutral-300">ملاحظة التذييل
                <input value={storeSettings.receipt_footer} onChange={e => setStoreSettings({ ...storeSettings, receipt_footer: e.target.value })} className={`${fieldClass} mt-1`} />
              </label>
              <label className="block text-sm text-neutral-300">رقم الضريبة / RC
                <input value={storeSettings.tax_rc} onChange={e => setStoreSettings({ ...storeSettings, tax_rc: e.target.value })} className={`${fieldClass} mt-1`} />
              </label>
              <div className="flex items-center gap-2">
                <input type="checkbox" checked={storeSettings.logo_on_receipt} onChange={e => setStoreSettings({ ...storeSettings, logo_on_receipt: e.target.checked })} className="w-4 h-4 rounded border-white/10 bg-[#1A1A1A]" />
                <span className="text-sm text-neutral-300">شعار المحل على الإيصال</span>
              </div>
              <div className="flex items-center gap-2">
                <input type="checkbox" checked={storeSettings.prices_on_receipt} onChange={e => setStoreSettings({ ...storeSettings, prices_on_receipt: e.target.checked })} className="w-4 h-4 rounded border-white/10 bg-[#1A1A1A]" />
                <span className="text-sm text-neutral-300">أسعار الوحدات على الإيصال</span>
              </div>
            </div>
            <button disabled={settingsBusy} onClick={saveStoreSettings} className={primaryClass}>{settingsBusy ? 'جاري الحفظ...' : 'حفظ التخصيص'}</button>
          </section>
        )}

        {/* TAB 3: OPERATIONAL POLICIES */}
        {activeTab === 'policies' && (
          <section className="rounded-2xl border border-white/10 bg-card p-5">
            <h2 className="mb-3 text-gold">سياسات التشغيل</h2>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="block text-sm text-neutral-300">مدة سياسة الإرجاع
                <CustomSelect value={storeSettings.return_policy_days} onChange={e => setStoreSettings({ ...storeSettings, return_policy_days: e })} options={RETURN_POLICY_OPTIONS} className={`${fieldClass} mt-1`} />
              </div>
              <label className="block text-sm text-neutral-300">عتبة تنبيه المخزون المنخفض
                <input type="number" min="0" value={storeSettings.low_stock_alert} onChange={e => setStoreSettings({ ...storeSettings, low_stock_alert: Number(e.target.value) })} className={`${fieldClass} mt-1`} />
              </label>
            </div>
            <button disabled={settingsBusy} onClick={saveStoreSettings} className={primaryClass}>{settingsBusy ? 'جاري الحفظ...' : 'حفظ السياسات'}</button>
          </section>
        )}

        {/* TAB 4: SYSTEM PREFERENCES */}
        {activeTab === 'system' && (
          <section className="rounded-2xl border border-white/10 bg-card p-5">
            <h2 className="mb-3 text-gold">تفضيلات النظام</h2>
            <div className="flex items-center gap-2">
              <input type="checkbox" checked={storeSettings.enable_barcode} onChange={e => setStoreSettings({ ...storeSettings, enable_barcode: e.target.checked })} className="w-4 h-4 rounded border-white/10 bg-[#1A1A1A]" />
              <span className="text-sm text-neutral-300">تفعيل الباركود في نقطة البيع</span>
            </div>
            <button disabled={settingsBusy} onClick={saveStoreSettings} className={primaryClass}>{settingsBusy ? 'جاري الحفظ...' : 'حفظ التفضيلات'}</button>
          </section>
        )}

        {/* TAB 5: GENERAL (Existing) */}
        {activeTab === 'general' && (
          <>
            <section className="rounded-2xl border border-white/10 bg-card p-5">
              <h2 className="mb-3 text-gold">الاشتراك والتفعيل</h2>
              <p className="mb-4 text-sm text-neutral-400">{ctx.tenant.name} · {ctx.tenant.is_active ? 'الحساب نشط' : 'فترة تجريبية'}{ctx.tenant.subscription_end_date && ` · نهاية الاشتراك: ${new Date(ctx.tenant.subscription_end_date).toLocaleDateString('ar-DZ')}`}</p>
              {ctx.role === 'owner' ? (
                <div className="space-y-5">
                  {ctx.tenant.is_active === true && <span className="inline-flex rounded-full border border-emerald-700/40 bg-emerald-950/40 px-3 py-1 text-xs text-emerald-300">الحساب نشط</span>}
                  <ActivationForm onActivated={() => location.reload()} />
                  <div className="border-t border-white/10 pt-5">
                    <ActivationForm upgrade onActivated={() => location.reload()} />
                  </div>
                </div>
              ) : (
                <p className="text-sm text-neutral-500">إدارة الاشتراك متاحة للمالك فقط.</p>
              )}
            </section>

            {ctx.role === 'owner' && (
              <section className="rounded-2xl border border-white/10 bg-card p-5">
                <h2 className="mb-3 text-gold">الفروع · {ctx.stores.length} / {ctx.tenant.branches_limit ?? 0}</h2>
                <p className="mb-4 text-xs text-neutral-500">إضافة الفروع حسب حد الاشتراك. استخدم مفتاح ترقية لزيادة الحد.</p>
                <div className="mb-4 flex flex-wrap gap-2">
                  {ctx.stores.map(store => <span key={store.id} className="rounded-lg bg-white/5 px-3 py-2 text-sm text-neutral-300">{store.name}</span>)}
                </div>
                <form onSubmit={event => {
                  event.preventDefault();
                  run(async () => {
                    if (!navigator.onLine) throw new Error('إضافة فرع تتطلب الاتصال')
                    if (!canAddBranch(ctx.stores.length, ctx.tenant.branches_limit)) {
                      alert('وصلت إلى حد الفروع. يرجى ترقية الاشتراك');
                      return;
                    }
                    const { error } = await supabase.rpc('engine_add_store', { p_name: name, p_address: address });
                    if (error) throw error;
                    location.reload();
                  });
                }}
                className="grid gap-3 sm:grid-cols-2"
              >
                <label className="text-sm text-neutral-300">اسم الفرع
                  <input required maxLength={200} disabled={busy} value={name} onChange={e => setName(e.target.value)} className={`${fieldClass} mt-1`} />
                </label>
                <label className="text-sm text-neutral-300">العنوان
                  <input disabled={busy} value={address} onChange={e => setAddress(e.target.value)} className={`${fieldClass} mt-1`} />
                </label>
                <button disabled={busy} className={primaryClass}>إضافة فرع</button>
              </form>
              </section>
            )}

            {ctx.role === 'owner' && (
              <section className="rounded-2xl border border-white/10 bg-card p-5">
                <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                  <h2 className="text-gold">الأجهزة النشطة · {sessions.length}</h2>
                  <button disabled={busy} onClick={() => run(refreshSessions)} className={secondaryClass}>تحديث</button>
                </div>
                <p className="mb-4 text-xs text-neutral-500">يُسمح بجهازين نشطين. تسجيل الدخول من جهاز ثالث يسجّل خروج أقدم جهاز تلقائياً.</p>
                <Notice success={sessionNotice} />
                {!sessions.length ? (
                  <p className="text-sm text-neutral-500">لا توجد أجهزة نشطة.</p>
                ) : (
                  <div className="space-y-2">
                    {sessions.map(row => {
                      const current = Boolean(myFingerprint) && row.device_fingerprint === myFingerprint;
                      return (
                        <article key={row.id} className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-white/5 p-3">
                          <div className="min-w-0">
                            <p className="text-sm text-neutral-200">{row.device_name || 'جهاز غير معروف'}{current && <span className="ms-2 rounded-full border border-emerald-700/40 bg-emerald-950/40 px-2 py-0.5 text-[10px] text-emerald-300">هذا الجهاز</span>}</p>
                            <p className="mt-1 text-xs text-neutral-500">{row.last_active ? `آخر نشاط: ${new Date(row.last_active).toLocaleString('ar-DZ')}` : 'لا يوجد نشاط مسجل'}</p>
                          </div>
                          <button disabled={busy} onClick={() => run(async () => {
                            setSessionNotice('');
                            await deactivateSession(supabase, { sessionId: row.id });
                            if (current) {
                              try {
                                const device = await describeDevice();
                                await deactivateCurrentDevice(supabase, { fingerprint: device.fingerprint });
                              } catch { /* ignore */ }
                              await supabase.auth.signOut({ scope: 'local' });
                              localStorage.removeItem('vetrina.auth');
                              location.assign('/login');
                              return;
                            }
                            setSessionNotice('تم تسجيل الخروج من الجهاز');
                            await refreshSessions();
                          })}
                          className="rounded-lg border border-red-800/40 px-3 py-1.5 text-xs text-red-300 disabled:opacity-50"
                        >
                          تسجيل الخروج من هذا الجهاز
                        </button>
                      </article>
                    )})}
                  </div>
                )}
              </section>
            )}

            {ctx.role !== 'employee' && (
              <section className="rounded-2xl border border-white/10 bg-card p-5">
                <h2 className="mb-3 text-gold">تصدير البيانات</h2>
                <p className="mb-4 text-xs text-neutral-500">ملفات CSV بترميز UTF-8 حسب الفرع المحدد (أو كل فروع المؤسسة للمالك). المبيعات المصدّرة هنا هي المتزامنة فقط.</p>
                <div className="flex flex-wrap gap-3">
                  <button disabled={busy} onClick={() => run(() => exportData('sales'))} className={secondaryClass}>تصدير المبيعات CSV</button>
                  <button disabled={busy} onClick={() => run(() => exportData('products'))} className={secondaryClass}>تصدير المنتجات CSV</button>
                </div>
              </section>
            )}

            <section className="rounded-2xl border border-white/10 bg-card p-5">
              <h2 className="mb-3 text-gold">المزامنة والفواتير المحلية · {rows.length}</h2>
              <p className="mb-4 text-xs text-neutral-500">لا تُحذف العمليات المتعارضة تلقائياً. صحّح المخزون أو السعر ثم أعد المحاولة. الفواتير محفوظة على هذا الجهاز ولهذا المستخدم فقط.</p>
              <div className="mb-4 flex flex-wrap gap-3">
                <button disabled={busy} onClick={() => run(syncPending)} className={primaryClass}>إعادة محاولة المزامنة</button>
                <button disabled={busy || !rows.length} onClick={() => download('vetrina-pending-receipts.json', JSON.stringify(rows, null, 2), 'application/json')} className={secondaryClass}>نسخة من العمليات المحلية JSON</button>
              </div>
              <div className="space-y-2">
                {rows.map(row => (
                  <article key={row.local_id} className="rounded-lg border border-white/5 p-3 text-xs text-neutral-300">
                    <p>{row.kind === 'audit' ? 'سجل تدقيق' : `فاتورة · ${formatDzd(row.total_amount)}`} · {new Date(row.created_at).toLocaleString('ar-DZ')}</p>
                    <p className="mt-1 text-neutral-500">{ctx.stores.find(store => store.id === row.store_id)?.name} · {row.local_id}</p>
                    <p className="mt-1 text-amber-300">{row.error || 'بانتظار الاتصال والمزامنة'}</p>
                  </article>
                ))}
              </div>
            </section>

            <button
              disabled={busy}
              onClick={() => run(async () => {
                const pending = (await localRows()).filter(row => row.auth_id === ctx.user.id && row.status !== 'synced');
                if (pending.length && !confirm('لديك عمليات غير متزامنة محفوظة لهذا المستخدم. ستظل على الجهاز ولن تتم مزامنتها إلا بعد عودتك لهذا الحساب. تسجيل الخروج؟')) {
                  return;
                }
                try {
                  const device = await describeDevice();
                  await deactivateCurrentDevice(supabase, { fingerprint: device.fingerprint });
                } catch {
                  /* logout must still proceed if bookkeeping fails */
                }
                const { error } = await supabase.auth.signOut({ scope: 'local' });
                if (error) throw error;
                localStorage.removeItem('vetrina.auth');
                location.assign('/login');
              })}
              className="rounded-lg border border-red-800/40 px-4 py-2 text-sm text-red-300"
            >
              تسجيل الخروج
            </button>
          </>
        )}
      </div>
    </>
  )
}
