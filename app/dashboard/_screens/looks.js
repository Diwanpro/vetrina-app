'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Notice, fieldClass, primaryClass, secondaryClass } from '@/components/dashboard/EngineUI'
import { formatDzd, getAppContext } from '@/lib/app-context'
import { safeVideoUrl } from '@/lib/video'
import { supabase } from '@/lib/supabase'

const BUCKET = 'look-images'
const MAX_BYTES = 8 * 1024 * 1024
const MAX_ITEMS = 12

const emptyForm = {
  id: null,
  name: '',
  description: '',
  imageUrl: '',
  videoUrl: '',
  bundlePrice: '',
  isActive: true,
}

// A look is a set of products sold together. The bundle price is written into
// `offers` by a trigger, so what this screen shows is the price the order will
// actually charge — the number here is never decorative.
export default function LooksPage() {
  const [ctx, setCtx] = useState(null)
  const [catalog, setCatalog] = useState([])
  const [looks, setLooks] = useState([])
  const [form, setForm] = useState(emptyForm)
  const [items, setItems] = useState([])   // [{ product_id, variant_id }]
  const [search, setSearch] = useState('')
  const [file, setFile] = useState(null)
  const [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const context = await getAppContext()
      setCtx(context)
      const [{ data: catalogData, error: catalogError }, { data: list, error: listError }] =
        await Promise.all([
          supabase.rpc('engine_look_catalog', { p_store: context.storeId }),
          supabase.rpc('engine_looks_list'),
        ])
      if (catalogError) throw catalogError
      if (listError) throw listError
      setCatalog(catalogData || [])
      setLooks(list || [])
      setError('')
    } catch (err) {
      console.error('[looks] load failed', err)
      setError(err.message || 'تعذر تحميل الإطلالات')
    } finally { setLoading(false) }
  }, [])

  useEffect(() => { load() }, [load])

  const byId = useMemo(() => new Map(catalog.map(row => [row.id, row])), [catalog])
  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase()
    if (!term) return catalog.slice(0, 8)
    return catalog.filter(row => row.name.toLowerCase().includes(term)).slice(0, 8)
  }, [catalog, search])

  // What the look is worth piece by piece, so the merchant can see the discount
  // they are about to give before they save it.
  const sum = useMemo(() => items.reduce((total, item) => {
    const product = byId.get(item.product_id)
    return total + Number(product?.base_price || 0)
  }, 0), [items, byId])

  const bundle = Number(form.bundlePrice || 0)
  const discount = bundle > 0 && sum > 0 ? sum - bundle : 0

  function reset() {
    setForm(emptyForm)
    setItems([])
    setSearch('')
    setFile(null)
  }

  function edit(look) {
    setError(''); setSuccess('')
    setForm({
      id: look.id,
      name: look.name || '',
      description: look.description || '',
      imageUrl: look.image_url || '',
      videoUrl: look.video_url || '',
      bundlePrice: look.bundle_price == null ? '' : String(look.bundle_price),
      isActive: look.is_active !== false,
    })
    setItems((look.items || []).map(item => ({ product_id: item.product_id, variant_id: item.variant_id || null })))
    setFile(null)
  }

  function toggleProduct(product) {
    setError('')
    setItems(previous => previous.some(item => item.product_id === product.id)
      ? previous.filter(item => item.product_id !== product.id)
      : [...previous, { product_id: product.id, variant_id: null }])
  }

  function setVariant(productId, variantId) {
    setItems(previous => previous.map(item =>
      item.product_id === productId ? { ...item, variant_id: variantId || null } : item))
  }

  async function upload() {
    if (!file) return form.imageUrl
    if (file.size > MAX_BYTES) throw new Error('حجم الصورة أكبر من 8 ميغابايت')
    if (!/^image\/(jpeg|png|webp|avif)$/.test(file.type)) {
      throw new Error('الصيغة يجب أن تكون JPG أو PNG أو WebP أو AVIF')
    }
    const extension = (file.name.split('.').pop() || 'jpg').toLowerCase().replace(/[^a-z0-9]/g, '')
    // The first path segment is the tenant: the storage policy checks it, so a
    // path built from another tenant's id is rejected by the database, not just
    // by this code.
    const path = `${ctx.tenantId}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${extension}`
    const { error: uploadError } = await supabase.storage.from(BUCKET)
      .upload(path, file, { cacheControl: '3600', upsert: false, contentType: file.type })
    if (uploadError) {
      console.error('[looks] upload failed', uploadError)
      throw new Error(uploadError.message || 'تعذر رفع الصورة')
    }
    const { data } = supabase.storage.from(BUCKET).getPublicUrl(path)
    return data?.publicUrl || ''
  }

  async function save(event) {
    event.preventDefault()
    if (busy) return
    setError(''); setSuccess('')

    if (!form.name.trim()) { setError('اسم الإطلالة مطلوب'); return }
    if (!items.length) { setError('أضف منتجاً واحداً على الأقل'); return }
    if (items.length > MAX_ITEMS) { setError(`الحد الأقصى ${MAX_ITEMS} منتجات في الإطلالة`); return }
    if (form.bundlePrice && Number(form.bundlePrice) > 0 && items.length < 2) {
      setError('سعر الإطلالة يتطلب منتجين على الأقل'); return
    }
    if (form.videoUrl && !safeVideoUrl(form.videoUrl)) {
      setError('رابط الفيديو غير صالح، استخدم رابط يوتيوب أو رابط فيديو مباشر'); return
    }

    setBusy(true)
    try {
      const imageUrl = await upload()
      const { error: rpcError } = await supabase.rpc('engine_save_look', {
        p_id: form.id,
        p_name: form.name,
        p_description: form.description,
        p_image_url: imageUrl,
        p_video_url: form.videoUrl,
        p_bundle_price: form.bundlePrice ? Number(form.bundlePrice) : null,
        p_is_active: form.isActive,
        p_items: items,
      })
      if (rpcError) throw rpcError
      setSuccess(form.id ? 'تم تحديث الإطلالة' : 'تم إنشاء الإطلالة')
      reset()
      await load()
    } catch (err) {
      console.error('[looks] save failed', err)
      setError(err.message || 'تعذر حفظ الإطلالة')
    } finally { setBusy(false) }
  }

  async function toggleActive(look) {
    setError('')
    try {
      const { error: rpcError } = await supabase.rpc('engine_set_look_active', {
        p_look: look.id, p_active: !look.is_active,
      })
      if (rpcError) throw rpcError
      await load()
    } catch (err) { console.error('[looks] toggle failed', err); setError(err.message) }
  }

  async function remove(look) {
    setError('')
    try {
      const { error: rpcError } = await supabase.rpc('engine_delete_look', { p_look: look.id })
      if (rpcError) throw rpcError
      if (form.id === look.id) reset()
      await load()
    } catch (err) { console.error('[looks] delete failed', err); setError(err.message) }
  }

  return <div className="mx-auto max-w-5xl space-y-5">
    <h1 className="text-xl text-neutral-100">الإطلالات</h1>
    <p className="text-xs leading-6 text-neutral-500">
      اجمع عدة منتجات في صورة واحدة. يشتري الزبون القطعة وحدها أو الإطلالة كاملة بسعر خاص.
    </p>
    <Notice error={error} success={success} />

    <form onSubmit={save} className="space-y-4 rounded-2xl border border-gold/20 bg-card p-5">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-gold">{form.id ? 'تعديل إطلالة' : 'إطلالة جديدة'}</h2>
        {form.id && <button type="button" onClick={reset} className={secondaryClass}>إلغاء التعديل</button>}
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <label className="block text-sm text-neutral-300">الاسم
          <input required value={form.name} disabled={busy} maxLength={120}
            onChange={event => setForm({ ...form, name: event.target.value })}
            className={`${fieldClass} mt-1`} placeholder="مثال: إطلالة الصيف" />
        </label>
        <label className="block text-sm text-neutral-300">سعر الإطلالة كاملة (دج، اختياري)
          <input inputMode="numeric" value={form.bundlePrice} disabled={busy}
            onChange={event => setForm({ ...form, bundlePrice: event.target.value.replace(/[^0-9]/g, '') })}
            className={`${fieldClass} mt-1`} placeholder={sum ? `السعر الحالي ${sum}` : 'اتركه فارغاً بدون خصم'} />
        </label>
        <label className="block text-sm text-neutral-300 sm:col-span-2">الوصف (اختياري)
          <textarea value={form.description} disabled={busy} maxLength={500} rows={2}
            onChange={event => setForm({ ...form, description: event.target.value })}
            className={`${fieldClass} mt-1`} placeholder="قطعة واحدة تصلح لكل المناسبات" />
        </label>
        <label className="block text-sm text-neutral-300">رابط الفيديو (اختياري)
          <input value={form.videoUrl} disabled={busy} dir="ltr"
            onChange={event => setForm({ ...form, videoUrl: event.target.value })}
            className={`${fieldClass} mt-1`} placeholder="https://youtube.com/..." />
        </label>
        <div className="block text-sm text-neutral-300">
          <span className="mb-1 block">صورة الإطلالة</span>
          <input type="file" accept="image/jpeg,image/png,image/webp,image/avif" disabled={busy}
            onChange={event => setFile(event.target.files?.[0] || null)}
            className="block w-full text-xs text-neutral-400 file:me-3 file:rounded-lg file:border-0 file:bg-white/10 file:px-3 file:py-2 file:text-xs file:text-neutral-200" />
          {(file || form.imageUrl) && <p className="mt-1 truncate text-[11px] text-neutral-500" dir="ltr">
            {file ? file.name : form.imageUrl}
          </p>}
        </div>
      </div>

      <section className="rounded-xl border border-white/10 bg-black/20 p-4">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h3 className="text-sm text-neutral-200">منتجات الإطلالة · {items.length}</h3>
          <p className="text-xs text-neutral-500">
            الإجمالي منفصلاً: <span className="text-neutral-300">{formatDzd(sum)}</span>
            {bundle > 0 && <span className={discount > 0 ? ' text-emerald-300' : ' text-red-300'}>
              {' '}· مع الإطلالة: {formatDzd(bundle)}{discount > 0 ? ` (تخفيض ${formatDzd(discount)})` : ''}
            </span>}
          </p>
        </div>

        {bundle > 0 && sum > 0 && bundle >= sum && (
          <p className="mt-2 text-xs text-amber-300">
            سعر الإطلالة ليس أقل من مجموع القطع، فلن يظهر أي خصم للزبون.
          </p>
        )}

        {items.length > 0 && <ul className="mt-3 space-y-2">
          {items.map(item => {
            const product = byId.get(item.product_id)
            if (!product) return null
            const variants = product.variants || []
            return <li key={item.product_id}
              className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-white/5 bg-white/[0.02] p-2">
              <span className="min-w-0 flex-1 truncate text-sm text-neutral-200">{product.name}</span>
              {variants.length > 0 && <select
                value={item.variant_id || ''}
                disabled={busy}
                onChange={event => setVariant(item.product_id, event.target.value)}
                className="min-h-9 rounded-lg border border-white/10 bg-[#141414] px-2 text-xs text-neutral-200"
              >
                <option value="">كل المقاسات</option>
                {variants.map(variant => <option key={variant.id} value={variant.id}>
                  {[variant.size, variant.color].filter(Boolean).join(' · ') || 'مقاس'}
                </option>)}
              </select>}
              <button type="button" onClick={() => toggleProduct(product)} disabled={busy}
                className="text-xs text-red-300">إزالة</button>
            </li>
          })}
        </ul>}

        <label className="mt-3 block text-sm text-neutral-300">
          <span className="mb-1 block">إضافة منتج</span>
          <input value={search} disabled={busy}
            onChange={event => setSearch(event.target.value)}
            className={`${fieldClass} mt-1`} placeholder="ابحث باسم المنتج" />
        </label>
        <ul className="mt-2 max-h-56 space-y-1 overflow-y-auto">
          {filtered.map(product => {
            const chosen = items.some(item => item.product_id === product.id)
            return <li key={product.id}>
              <button type="button" onClick={() => toggleProduct(product)} disabled={busy}
                className={`flex w-full items-center justify-between gap-3 rounded-lg px-3 py-2 text-start text-sm transition ${
                  chosen ? 'bg-gold/10 text-gold' : 'text-neutral-300 hover:bg-white/5'}`}>
                <span className="truncate">{product.name}</span>
                <span className="shrink-0 text-xs text-neutral-500">
                  {formatDzd(product.base_price || 0)}{chosen ? ' · مضاف' : ''}
                </span>
              </button>
            </li>
          })}
          {!filtered.length && <li className="px-3 py-2 text-xs text-neutral-500">لا نتائج</li>}
        </ul>
      </section>

      <label className="flex items-center gap-2 text-sm text-neutral-300">
        <input type="checkbox" checked={form.isActive} disabled={busy}
          onChange={event => setForm({ ...form, isActive: event.target.checked })} />
        معروضة في المتجر
      </label>

      <button disabled={busy} className={primaryClass}>
        {busy ? 'جاري الحفظ...' : form.id ? 'تحديث الإطلالة' : 'إنشاء الإطلالة'}
      </button>
    </form>

    <section className="rounded-2xl border border-white/10 bg-card p-5">
      <h2 className="mb-3 text-gold">الإطلالات · {looks.length}</h2>
      {loading ? <p className="text-sm text-neutral-500">جاري التحميل...</p>
        : !looks.length ? <p className="text-sm text-neutral-500">لا توجد إطلالات بعد.</p>
        : <ul className="grid gap-3 sm:grid-cols-2">
          {looks.map(look => <li key={look.id} className="overflow-hidden rounded-xl border border-white/5">
            {look.image_url
              ? <img src={look.image_url} alt="" className="h-36 w-full object-cover" />
              : <div className="flex h-36 items-center justify-center bg-black/30 text-xs text-neutral-600">بدون صورة</div>}
            <div className="space-y-2 p-3">
              <div className="flex items-start justify-between gap-2">
                <p className="min-w-0 truncate text-sm text-neutral-100">{look.name}</p>
                {look.is_active
                  ? <span className="shrink-0 rounded-full bg-emerald-500/10 px-2 py-0.5 text-[10px] text-emerald-300">معروضة</span>
                  : <span className="shrink-0 rounded-full bg-white/5 px-2 py-0.5 text-[10px] text-neutral-400">مخفية</span>}
              </div>
              <p className="text-xs text-neutral-500">
                {(look.items || []).length} منتجات
                {look.bundle_price != null && <> · {formatDzd(look.bundle_price)} للإطلالة</>}
              </p>
              <div className="flex flex-wrap gap-2">
                <button type="button" onClick={() => edit(look)} className={secondaryClass}>تعديل</button>
                <button type="button" onClick={() => toggleActive(look)} className={secondaryClass}>
                  {look.is_active ? 'إخفاء' : 'عرض'}
                </button>
                <button type="button" onClick={() => remove(look)}
                  className="rounded-lg border border-red-800/40 px-3 py-2 text-xs text-red-300">حذف</button>
              </div>
            </div>
          </li>)}
        </ul>}
    </section>
  </div>
}
