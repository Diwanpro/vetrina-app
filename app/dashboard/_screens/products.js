'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { normalizeColorComponents, colorLabel, sizeLabel } from '@/lib/product-attributes'
import VoiceInput from '@/components/VoiceInput'
import BarcodeScanner from '@/components/dashboard/BarcodeScanner'
import { fetchAllRows } from '@/lib/cash'
import { SIZE_TYPES, sizesForType, emptySizeRow, emptySizeMatrix, filledSizeCells } from '@/lib/product-sizes'
import { MAIN_CATEGORIES, subcategoriesFor, storeTypeLabel } from '@/lib/categories'
import { mergeMockProducts } from '@/lib/mock-catalog'
import KeyboardWedgeListener from '@/components/dashboard/KeyboardWedgeListener'
import { loadCustomSubcategories, saveCustomSubcategory } from '@/lib/subcategories'
import { supabase } from '@/lib/supabase'
import { formatDzd, getAppContext } from '@/lib/app-context'
import { selectClass } from '@/components/dashboard/EngineUI'
import CustomSelect from '@/components/ui/CustomSelect'
import SearchableSelect from '@/components/ui/SearchableSelect'
import { safeVideoUrl, videoButtonLabel } from '@/lib/video'
import { notifyBranchPush } from '@/lib/push/client'
import { barcodeCellKey, productBarcodePayload, validateBarcode } from '@/lib/barcode/hybrid'

import { brandsFor, cleanBrand } from '@/lib/brand-catalog'
import { FABRIC_OPTIONS, STYLE_OPTIONS, generateDescription, generateProductName, smartSpecsFromForm, validateSmartEntry } from '@/lib/product-entry'

const DEFAULT_COLORS = ['أبيض', 'أسود', 'أزرق', 'أحمر', 'بيج']
function firstImage(product) {
  if (Array.isArray(product.images) && product.images.length) return product.images[0]
  return product.image_url || ''
}

// Collapsible add-form section. The body stays mounted and is only hidden
// with CSS, so folding a section never unmounts an input or drops draft data.
function ProductSection({ id, title, open, onToggle, summary, children }) {
  const bodyId = `product-section-${id}`
  return (
    <section className="rounded-xl border border-white/10 bg-[#1a1a1a]">
      <h3 className="m-0">
        <button
          type="button"
          aria-expanded={open}
          aria-controls={bodyId}
          onClick={onToggle}
          className="flex w-full items-center justify-between gap-3 px-3 py-2.5 text-start"
        >
          <span className="flex min-w-0 items-center gap-2">
            <span className="text-sm font-medium text-neutral-100">{title}</span>
            {!open && summary ? <span className="truncate text-[11px] text-neutral-500">{summary}</span> : null}
          </span>
          <svg aria-hidden="true" viewBox="0 0 24 24" className={`h-4 w-4 shrink-0 text-gold transition-transform ${open ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M6 9l6 6 6-6" />
          </svg>
        </button>
      </h3>
      <div id={bodyId} className={open ? 'px-3 pb-3' : 'hidden'}>
        {children}
      </div>
    </section>
  )
}

export default function ProductsPage() {
  const [products, setProducts] = useState([])
  const [search, setSearch] = useState('')
  const [loading, setLoading] = useState(true)
  const [open, setOpen] = useState(false)
  const [scanning, setScanning] = useState(false)
  const cameraInput = useRef(null)
  const [generating, setGenerating] = useState(false)
  const barcodeTask = useRef(0)
  const productSaving = useRef(false)
  const [variantBarcodes, setVariantBarcodes] = useState({})
  const [saveUncertain, setSaveUncertain] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [ctx, setCtx] = useState({ tenantId: null, storeId: null, storeType: 'mens' })
  const [form, setForm] = useState({
    name: '',
    description: '',
    category: MAIN_CATEGORIES[0],
    subcategory: '',
    base_price: '',
    cost_price: '',
    barcode: '',
    external_video_url: '',
    imageFile: null,
    imagePreview: '',
  })
  // The video link is the one product field a merchant edits after the fact,
  // because a campaign video is usually ready after the product exists.
  const [videoTarget, setVideoTarget] = useState(null)
  const [videoValue, setVideoValue] = useState('')
  const [videoBusy, setVideoBusy] = useState(false)
  const [videoError, setVideoError] = useState('')
  const [sizeType, setSizeType] = useState(SIZE_TYPES[0].value)
  const sizes = sizesForType(sizeType)
  const [matrix, setMatrix] = useState(() => emptySizeMatrix(DEFAULT_COLORS, sizesForType(SIZE_TYPES[0].value)))
  const [newColor, setNewColor] = useState('')
  const [colorMode, setColorMode] = useState('single')
  const [components, setComponents] = useState([])
  const [colorMetadata, setColorMetadata] = useState({})
  const [customSubs, setCustomSubs] = useState({})
  // Collapsible add-form sections. Basics and variants start open, the rest
  // start folded. This state only drives visibility: no draft value lives here.
  const [sections, setSections] = useState(() => ({ basics: true, variants: true, pricing: false, barcode: false, media: false }))

  function openVideoEditor(product) {
    setVideoTarget(product)
    setVideoValue(product.external_video_url || '')
    setVideoError('')
  }

  async function saveVideoLink() {
    if (!videoTarget) return
    const raw = videoValue.trim()
    const clean = raw ? safeVideoUrl(raw) : ''
    if (raw && !clean) {
      setVideoError('رابط غير صالح. الصق رابطاً يبدأ بـ https:// (تيك توك، إنستغرام، فيسبوك…)')
      return
    }
    setVideoBusy(true)
    setVideoError('')
    try {
      const { error: updateError } = await supabase
        .from('products')
        .update({ external_video_url: clean || null })
        .eq('id', videoTarget.id)
      if (updateError) throw updateError
      setVideoTarget(null)
      setVideoValue('')
      await loadProducts()
    } catch (err) {
      setVideoError(err.message)
    } finally {
      setVideoBusy(false)
    }
  }

  async function loadProducts() {
    setLoading(true)
    try {
      const context = await getAppContext()
      if (!context.tenantId || !context.storeId) throw new Error('تعذر تحديد المتجر')
      setCtx(context)
      const rows = await fetchAllRows(supabase.from('products')
        .select('id, name, brand, description, category, subcategory, base_price, images, image_url, external_video_url, product_barcodes(barcode), product_variants!inner(id, barcode, color, color_components, size, inventory!inner(quantity, store_id))')
        .eq('tenant_id', context.tenantId).eq('product_variants.inventory.store_id', context.storeId).order('created_at', { ascending: false }).order('id'))
      setProducts(mergeMockProducts(rows, context.storeType, context.storeId, 'dashboard'))
    } catch (err) { setError(err.message) }
    finally { setLoading(false) }
  }

  useEffect(() => { loadProducts(); return () => { barcodeTask.current += 1 } }, [])

  // Loaded once per page load, not per focus: a refresh is enough to pick up
  // subcategories another device added. A failure here must never block the
  // catalogue, so it is logged rather than surfaced.
  useEffect(() => {
    if (!ctx.tenantId) return
    let cancelled = false
    loadCustomSubcategories(supabase, ctx.tenantId)
      .then(rows => { if (!cancelled) setCustomSubs(rows) })
      .catch(err => console.error('[products] custom subcategories failed', err))
    return () => { cancelled = true }
  }, [ctx.tenantId])

  // Defaults from lib/categories.js, plus this tenant's saved custom entries,
  // plus anything already used by existing products (covers rows created
  // before this feature existed).
  const subcategoryOptions = useMemo(() => {
    const seeded = subcategoriesFor(form.category, ctx.storeType)
    const custom = customSubs[form.category] || []
    const used = products
      .filter(product => product.category === form.category && product.subcategory)
      .map(product => product.subcategory)
    return [...new Set([...seeded, ...custom, ...used])].map(label => ({ label, value: label }))
  }, [form.category, ctx.storeType, customSubs, products])

  // The HID/Keyboard-Wedge scanner writes into this same field, so a scanned
  // barcode filters by name, category or any variant barcode.
  const visibleProducts = useMemo(() => {
    const term = search.trim().toLowerCase()
    if (!term) return products
    return products.filter(product => [
      product.name, product.description, product.category, product.subcategory,
      ...(product.product_variants || []).flatMap(variant => [variant.barcode, variant.sku]),
      ...(product.product_barcodes || []).map(row => row.barcode),
    ].some(value => String(value || '').toLowerCase().includes(term)))
  }, [products, search])

  async function createSubcategory(name) {
    try {
      const saved = await saveCustomSubcategory(supabase, {
        tenantId: ctx.tenantId,
        category: form.category,
        name,
      })
      if (!saved) return
      setCustomSubs(previous => ({
        ...previous,
        [saved.category]: [...new Set([...(previous[saved.category] || []), saved.name])],
      }))
    } catch (err) {
      setError(err.message || 'تعذر حفظ التصنيف الفرعي')
    }
  }

  async function allocateBarcodes(count) {
    if (!count) return []
    const context = await getAppContext()
    if (!context.storeId || !context.tenantId) throw new Error('تعذر تحديد المتجر')
    const { data, error } = await supabase.rpc('engine_generate_barcodes', {
      p_store: context.storeId, p_tenant: context.tenantId, p_count: count,
    })
    if (error) throw error
    return data
  }
  async function regenerateBarcode() {
    const task = ++barcodeTask.current
    setGenerating(true); setError('')
    try {
      const [code] = await allocateBarcodes(1)
      if (task === barcodeTask.current) setForm(prev => ({ ...prev, barcode: code }))
    } catch (err) { if (task === barcodeTask.current) setError(err.message || 'تعذر توليد الباركود') }
    finally { if (task === barcodeTask.current) setGenerating(false) }
  }
  function toggleSection(key) {
    setSections(previous => ({ ...previous, [key]: !previous[key] }))
  }
  // A save error points at a field inside one section: fold that section back
  // open so the message and the offending input are reachable. The checks
  // themselves are untouched.
  function revealSection(key) {
    setSections(previous => ({ ...previous, [key]: true }))
  }
  function openProductForm() {
    setOpen(true); setError('')
    setSaveUncertain(false)
    setSections({ basics: true, variants: true, pricing: false, barcode: false, media: false })
  }
  function closeProductForm() {
    if (saving) return
    barcodeTask.current += 1; setGenerating(false); setOpen(false)
  }

  const colorRows = Object.keys(matrix)
  const filledCellCount = Object.values(matrix).reduce(
    (sum, row) => sum + Object.values(row).filter(qty => Number(qty) > 0).length,
    0,
  )

  function changeSizeType(type) {
    if (type === sizeType) return
    if ((Object.values(matrix).some(row => Object.values(row).some(q => String(q) !== '')) || Object.values(variantBarcodes).some(Boolean)) && !window.confirm('سيتم مسح الكميات وباركودات التركيبات. هل تريد المتابعة؟')) return
    setSizeType(type)
    setVariantBarcodes({})
    // Reset all quantities, including overlapping numeric sizes, so shoe stock
    // can never silently become pants stock (or vice versa).
    setMatrix(prev => emptySizeMatrix(Object.keys(prev), sizesForType(type)))
    setError('')
  }

  function addCustomColor() {
    try {
      const parts = normalizeColorComponents(colorMode === 'composite' ? components : [newColor])
      if (colorMode === 'composite' && parts.length < 2) throw new Error('اختر لونين على الأقل')
      const color = colorLabel(parts)
      if (Object.hasOwn(matrix, color)) throw new Error('هذا اللون موجود مسبقاً')
      setColorMetadata(prev => ({ ...prev, [color]: parts }))
      setMatrix(prev => ({ ...prev, [color]: emptySizeRow(sizes) }))
      setNewColor(''); setComponents([]); setError('')
    } catch (err) { setError(err.message) }
  }

  async function handleSave(e) {
    e.preventDefault()
    if (productSaving.current || generating || saveUncertain) return
    setError('')
    let filledCells, payload
    try {
      filledCells = filledSizeCells(matrix, sizes).map(cell => ({ ...cell, color_components: colorMetadata[cell.color] || [cell.color] }))
    } catch (err) { setError(err.message); revealSection('variants'); return }
    try {
      payload = productBarcodePayload(filledCells, form.barcode, variantBarcodes)
    } catch (err) { setError(err.message); revealSection('barcode'); return }
    const validation = validateSmartEntry({ ...form, cells: filledCells })
    // Same first check the validator performs: no image at all. Anything else
    // it reports comes from the colour/size/quantity cells.
    if (validation) { setError(validation); revealSection(!form.imageFile && !form.imagePreview ? 'media' : 'variants'); return }
    const specs = smartSpecsFromForm(form, filledCells, ctx)
    const productName = form.name.trim() || [cleanBrand(form.brand), generateProductName(specs)].filter(Boolean).join(' · ')
    const videoUrl = form.external_video_url.trim() ? safeVideoUrl(form.external_video_url) : ''
    if (form.external_video_url.trim() && !videoUrl) { setError('رابط الفيديو غير صالح'); revealSection('media'); return }
    if (!ctx.tenantId || !ctx.storeId) { setError('تعذر تحديد المؤسسة والفرع'); return }
    productSaving.current = true; setSaving(true)
    let rpcStarted = false
    try {
      let images = []
      // Storage is outside the SQL transaction. Never delete an uploaded image
      // after an ambiguous network response: the product may already be committed.
      if (form.imageFile) {
        const ext = (form.imageFile.name.split('.').pop() || 'jpg').toLowerCase().replace(/[^a-z0-9]/g, '') || 'jpg'
        const path = `${ctx.tenantId}/${crypto.randomUUID()}.${ext}`
        const { error: upErr } = await supabase.storage.from('products').upload(path, form.imageFile, { cacheControl: '3600', upsert: false, contentType: form.imageFile.type || 'image/jpeg' })
        if (upErr) throw upErr
        const { data: pub } = supabase.storage.from('products').getPublicUrl(path)
        if (pub?.publicUrl) images = [pub.publicUrl]
      }
      rpcStarted = true
      const { data: productId, error: rpcError } = await supabase.rpc('engine_create_product_atomic', {
        p_store: ctx.storeId, p_tenant: ctx.tenantId,
        p_product: { name: productName, brand: cleanBrand(form.brand) || null,
          description: form.description.trim() || generateDescription(specs), category: form.category,
          subcategory: form.subcategory.trim() || null, base_price: Number(form.base_price || 0),
          images, image_url: images[0] || null, external_video_url: videoUrl || null },
        p_variants: payload.variants.map(v => ({ ...v, cost_price_avg: Number(form.cost_price || 0) })),
        p_model_barcodes: payload.modelBarcodes,
      })
      if (rpcError) throw rpcError
      if (!productId) throw new Error('لم يصل تأكيد الحفظ')
      void notifyBranchPush({ storeId: ctx.storeId, kind: 'product', name: productName }).catch(() => {})
      setOpen(false)
      setForm({ name: '', description: '', category: MAIN_CATEGORIES[0], subcategory: '', base_price: '', cost_price: '', barcode: '', external_video_url: '', imageFile: null, imagePreview: '' })
      setVariantBarcodes({})
      setColorMetadata({}); setComponents([]); setColorMode('single')
      setSizeType(SIZE_TYPES[0].value)
      setMatrix(emptySizeMatrix(DEFAULT_COLORS, sizesForType(SIZE_TYPES[0].value)))
      setNewColor(''); await loadProducts()
    } catch (err) {
      if (rpcStarted && !err.code) {
        setSaveUncertain(true)
        setError('تعذر تأكيد نتيجة الحفظ. لا تعِد الإرسال؛ أغلق النموذج وحدّث قائمة المنتجات للتحقق أولاً. ' + (err.message || ''))
      } else {
        setError(err.code === '23505' ? 'هذا الباركود مستخدم في المؤسسة؛ اختر رمزاً آخر.' : err.message || 'تعذر حفظ المنتج')
        // Storage is the only awaited step before the RPC, so a failure there
        // is an image problem; a duplicate-code RPC error is a barcode problem.
        if (!rpcStarted) revealSection('media')
        else if (err.code === '23505') revealSection('barcode')
      }
    } finally { productSaving.current = false; setSaving(false) }
  }


  return (
    <>
      <div className="mb-3 flex items-center justify-between gap-2">
        <h1 className="text-base font-medium text-neutral-100">المنتجات</h1>
        <button
          type="button"
          onClick={openProductForm}
          className="rounded-lg bg-gold px-3 py-2 text-sm font-medium text-[#121212]"
        >
          إضافة منتج
        </button>
      </div>

      <KeyboardWedgeListener onScan={(code, input) => {
        if (input?.dataset?.variantBarcodeKey) setVariantBarcodes(prev => ({ ...prev, [input.dataset.variantBarcodeKey]: code }))
        else if (input?.id === 'product-barcode') setForm(prev => ({ ...prev, barcode: code }))
        else setSearch(code)
      }} />
      <label className="mb-3 block text-xs text-neutral-400">
        بحث بالاسم أو التصنيف أو الباركود (يعمل مع قارئ HID / Keyboard Wedge)
        <input
          data-barcode-input="products-search"
          value={search}
          onChange={event => setSearch(event.target.value)}
          placeholder="امسح الباركود أو اكتب اسم المنتج..."
          className="mt-1 w-full rounded-lg border border-neutral-700 bg-[#141414] px-3 py-2 text-sm text-white outline-none focus:border-gold"
        />
      </label>

      <button type="button" onClick={() => setScanning('search')} className="mb-3 rounded-lg border border-gold/30 px-3 py-2 text-xs text-gold">مسح الباركود للبحث بالكاميرا</button>
      {!open && error && <p role="alert" className="mb-3 text-sm text-red-300">{error}</p>}
      {loading ? (
        <p className="text-sm text-neutral-500">جاري التحميل...</p>
      ) : visibleProducts.length === 0 ? (
        <div className="rounded-xl border border-dashed border-white/10 bg-card p-8 text-center">
          <p className="text-sm text-neutral-300">لا توجد منتجات بعد</p>
          <p className="mt-1 text-xs text-neutral-500">أضف أول منتج لبدء نقطة البيع</p>
        </div>
      ) : (
        <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-4 gap-2.5">
          {visibleProducts.map((p) => {
            const stock = (p.product_variants || []).reduce(
              (sum, v) => sum + (v.inventory || []).filter(i => i.store_id === ctx.storeId).reduce((s, i) => s + Number(i.quantity || 0), 0),
              0
            )
            const img = firstImage(p)
            return (
              <article key={p.id} className="rounded-xl border border-white/5 bg-card overflow-hidden">
                <div className="aspect-square bg-[#222] flex items-center justify-center">
                  {img ? (
                    <img src={img} alt={p.name} className="h-full w-full object-cover" />
                  ) : (
                    <span className="text-xs text-neutral-500">بدون صورة</span>
                  )}
                </div>
                <div className="p-2.5">
                  <p className="text-sm text-neutral-100 truncate">{p.name}</p>
                  <p className="text-[11px] text-neutral-500">{p.category || '—'}{p.subcategory ? ` · ${p.subcategory}` : ''}</p>
                  <a href={`/dashboard/products/barcodes?product=${encodeURIComponent(p.id)}`} target="_blank" rel="noopener noreferrer"
                    className="mt-2 mb-2 block rounded-lg border border-gold/20 px-2 py-1.5 text-center text-xs text-gold">طباعة الباركود</a>
                  <button
                    type="button"
                    onClick={() => openVideoEditor(p)}
                    className={`mb-2 flex w-full items-center justify-center gap-1 rounded-lg border px-2 py-1.5 text-xs ${
                      p.external_video_url
                        ? 'border-sky-400/30 bg-sky-400/10 text-sky-200'
                        : 'border-white/10 text-neutral-300'
                    }`}
                  >
                    <span aria-hidden="true">▶</span>
                    {p.external_video_url ? 'فيديو المنتج' : 'رابط فيديو'}
                  </button>
                  <div className="mt-1 flex items-center justify-between">
                    <span className="text-sm font-medium text-gold">{formatDzd(p.base_price)}</span>
                    <span className="text-[11px] text-neutral-500">المخزون: {stock}</span>
                  </div>
                </div>
              </article>
            )
          })}
        </div>
      )}

      {videoTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4">
          <section role="dialog" aria-modal="true" aria-label="رابط فيديو المنتج" className="w-full max-w-md rounded-2xl border border-gold/20 bg-[#171717] p-5 text-neutral-100">
            <div className="mb-4 flex items-center justify-between gap-3">
              <h2 className="text-sm font-medium text-gold">فيديو المنتج</h2>
              <button type="button" onClick={() => setVideoTarget(null)} disabled={videoBusy} className="text-xs text-neutral-400 disabled:opacity-50">إغلاق</button>
            </div>
            <p className="mb-3 truncate text-xs text-neutral-400">{videoTarget.name}</p>
            <label className="block text-xs text-neutral-400">
              رابط فيديو المنتج (تيك توك / إنستغرام / فيسبوك)
              <input
                type="url"
                dir="ltr"
                inputMode="url"
                autoFocus
                value={videoValue}
                onChange={event => setVideoValue(event.target.value)}
                placeholder="https://www.tiktok.com/@shop/video/..."
                className="mt-1 w-full rounded-lg border border-neutral-700 bg-[#141414] px-3 py-2 text-start text-sm text-white outline-none focus:border-gold"
              />
            </label>
            {videoValue.trim() && safeVideoUrl(videoValue) && (
              <a
                href={safeVideoUrl(videoValue)}
                target="_blank"
                rel="noopener noreferrer"
                className="mt-2 inline-block text-[11px] text-sky-300 underline underline-offset-4"
              >
                {videoButtonLabel(videoValue, 'معاينة')}
              </a>
            )}
            {videoError && <p role="alert" className="mt-2 text-xs text-red-300">{videoError}</p>}
            <div className="mt-4 flex justify-end gap-2">
              {videoTarget.external_video_url && (
                <button
                  type="button"
                  disabled={videoBusy}
                  onClick={() => setVideoValue('')}
                  className="rounded-lg border border-white/10 bg-[#222] px-3 py-2 text-sm text-neutral-200 disabled:opacity-50"
                >
                  حذف الرابط
                </button>
              )}
              <button
                type="button"
                disabled={videoBusy}
                onClick={saveVideoLink}
                className="rounded-lg bg-gold px-4 py-2 text-sm font-medium text-[#121212] disabled:opacity-50"
              >
                {videoBusy ? 'جاري الحفظ...' : 'حفظ'}
              </button>
            </div>
          </section>
        </div>
      )}

      {open && (
        <div className="fixed inset-0 z-50 bg-black/70 flex items-end md:items-center justify-center p-0 md:p-4">
          <form
            onSubmit={handleSave}
            className="w-full max-w-lg max-h-[92vh] overflow-y-auto rounded-t-2xl md:rounded-2xl bg-[#171717] border border-white/10 p-4"
          >
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-sm font-medium text-neutral-100">إضافة منتج</h2>
              <button type="button" onClick={closeProductForm} className="text-xs text-neutral-400">
                إغلاق
              </button>
            </div>

            <div className="space-y-3">
              <ProductSection id="basics" title="المعلومات الأساسية" open={sections.basics} onToggle={() => toggleSection('basics')}
                summary={[form.name.trim(), form.brand, form.subcategory].filter(Boolean).join(' · ') || form.category}>
                <div className="space-y-3">
              <div className="block">
                <span className="mb-1 block text-xs text-neutral-400">نوع المنتج</span>
                <CustomSelect
                  value={form.category}
                  onChange={e => setForm({ ...form, category: e, subcategory: '', brand: '' })}
                  options={MAIN_CATEGORIES.map(c => ({ label: c, value: c }))}
                  className={`${selectClass} mt-1`}
                />
                <span className="mt-1 block text-[11px] text-neutral-500">
                  نوع المتجر الحالي: {storeTypeLabel(ctx.storeType)} · تتغير التصنيفات تلقائياً مع نوع المنتج.
                </span>
              </div>
              <div className="block">
                <span className="mb-1 block text-xs text-neutral-400">التصنيف (حسب نوع المتجر)</span>
                <CustomSelect
                  value={form.subcategory}
                  onChange={next => setForm(previous => ({ ...previous, subcategory: next, brand: '' }))}
                  options={subcategoryOptions}
                  placeholder="اختر التصنيف"
                  aria-label="التصنيف حسب نوع المتجر"
                  className={`${selectClass} mt-1`}
                />
                <span className="mt-1 block text-[11px] text-neutral-500">
                  مثال: متجر نسائي + أحذية ← كعب عالي، صنادل، أحذية رياضية نسائية.
                </span>
              </div>

              <CustomSelect searchable allowCreate aria-label="الماركة / اسم المنتج" value={form.brand || ''}
                options={[{ value: '', label: 'بدون ماركة · اختياري' }, ...brandsFor(form.category, form.subcategory, products.map(product => product.brand))]}
                placeholder="الماركة / اسم المنتج · ابحث أو اكتب ماركة محلية"
                onChange={brand => setForm(prev => ({ ...prev, brand: cleanBrand(brand) }))} />

              <label className="block">
                <span className="mb-1 block text-xs text-neutral-400">اسم المنتج</span>
                <input
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                  className="w-full rounded-lg border border-neutral-700 bg-[#141414] px-3 py-2 text-sm outline-none focus:border-gold"
                />
              </label>
              <div>
                <div className="mb-2 flex items-start justify-between gap-3">
                  <label htmlFor="product-description" className="text-xs text-neutral-400">وصف المنتج</label>
                  <VoiceInput value={form.description} onChange={text => setForm(prev => ({ ...prev, description: text }))} disabled={saving} />
                </div>
                <textarea id="product-description" value={form.description} disabled={saving} maxLength={4000}
                  onChange={e => setForm(prev => ({ ...prev, description: e.target.value }))} rows={3}
                  placeholder="اكتب تفاصيل المنتج أو أمْلِها بالصوت…"
                  className="w-full resize-y rounded-lg border border-neutral-700 bg-[#141414] px-3 py-2 text-sm outline-none focus:border-gold" />
              </div>
                  <div className="grid grid-cols-2 gap-2">
                    <CustomSelect aria-label="نوع القماش" value={form.fabric || ''} options={FABRIC_OPTIONS} onChange={fabric => setForm(prev => ({ ...prev, fabric }))} />
                    <CustomSelect aria-label="الستايل" value={form.style || ''} options={STYLE_OPTIONS} onChange={style => setForm(prev => ({ ...prev, style }))} />
                  </div>
                  <button type="button" className="text-sm text-gold" onClick={() => {
                    try { setForm(prev => ({ ...prev, description: generateDescription(smartSpecsFromForm(prev, filledSizeCells(matrix, sizes), ctx)) })) }
                    catch (err) { setError(err.message) }
                  }}>توليد وصف عربي تلقائياً</button>
                  <p className="text-xs text-neutral-400">الإلزامي فقط: الصورة واللون والمقاسات والكمية. الاسم والوصف يولدان تلقائياً. السعر اختياري (افتراضياً 0 دج، راجعه قبل البيع).</p>
                </div>
              </ProductSection>

              <ProductSection id="variants" title="الألوان والمقاسات والكميات" open={sections.variants} onToggle={() => toggleSection('variants')}
                summary={`${colorRows.length} لون · ${filledCellCount} خلية بالكمية`}>
                <div className="space-y-3">
              <div className="block">
                <span className="mb-1 block text-xs text-neutral-400">نوع المقاس</span>
                <CustomSelect
                  value={sizeType}
                  disabled={saving}
                  onChange={e => changeSizeType(e)}
                  options={SIZE_TYPES.map(option => ({ label: `${option.label} (${option.sizes.map(sizeLabel).join(', ')})`, value: option.value }))}
                  className={`${selectClass} mt-1`}
                />
                <span id="size-type-help" className="mt-1 block text-[11px] text-neutral-500">تغيير نوع المقاس يمسح كميات الجدول. أدخل الكميات بعد اختيار النوع.</span>
              </div>
              <div>
                <p className="mb-1.5 text-xs text-neutral-400">المخزون حسب اللون والمقاس</p>
                <CustomSelect aria-label="نوع اللون" value={colorMode} options={[{value:'single',label:'لون مفرد'},{value:'composite',label:'لون مركب'}]} onChange={setColorMode} disabled={saving} />
                {colorMode === 'composite' && <div className="my-2 space-y-2">
                  <CustomSelect aria-label="مكونات اللون المركب" value="" placeholder="أضف مكوّن لون" disabled={saving} options={[...new Set([...DEFAULT_COLORS, ...Object.keys(matrix), newColor.trim()].filter(Boolean))].filter(c => !components.includes(c) && (colorMetadata[c]?.length || 1) === 1).map(c => ({value:c,label:c}))} onChange={c => { if (components.length < 6) setComponents(prev => [...prev,c]) }} />
                  <p className="text-xs text-neutral-400">{components.join(' / ') || 'اختر لونين على الأقل — يمكنك كتابة اسم جديد أدناه ثم اختياره'}</p>
                  {components.map(c => <button type="button" key={c} onClick={() => setComponents(prev => prev.filter(x => x !== c))} className="m-1 rounded border border-neutral-600 p-2 text-xs">إزالة {c}</button>)}
                </div>}
                <div className="mb-2 flex gap-2">
                  <input
                    value={newColor}
                    onChange={(e) => setNewColor(e.target.value)}
                    placeholder="لون جديد"
                    className="flex-1 rounded-lg border border-neutral-700 bg-[#141414] px-3 py-2 text-sm outline-none focus:border-gold"
                  />
                  <button
                    type="button"
                    onClick={addCustomColor}
                    className="shrink-0 rounded-lg border border-gold/40 px-3 py-2 text-xs text-gold"
                  >
                    إضافة لون
                  </button>
                </div>
                <div className="overflow-x-auto rounded-lg border border-white/10">
                  <table className="w-full text-center text-xs">
                    <thead className="bg-[#1f1f1f] text-neutral-400">
                      <tr>
                        <th className="p-2">اللون</th>
                        {sizes.map((s) => (
                          <th key={s} className="p-2">{sizeLabel(s)}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {colorRows.map((color) => (
                        <tr key={color} className="border-t border-white/5">
                          <td className="p-2 text-neutral-300 whitespace-nowrap">{color}</td>
                          {sizes.map((size) => (
                            <td key={size} className="p-1">
                              <input
                                type="number"
                                min="0"
                                step="1"
                                disabled={saving}
                                aria-label={`كمية ${color} مقاس ${sizeLabel(size)}`}
                                value={matrix[color][size] ?? ''}
                                onChange={(e) =>
                                  setMatrix((prev) => ({
                                    ...prev,
                                    [color]: { ...prev[color], [size]: e.target.value },
                                  }))
                                }
                                className="w-12 rounded border border-neutral-700 bg-[#141414] py-1 text-center outline-none focus:border-gold"
                              />
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
                </div>
              </ProductSection>

              <ProductSection id="pricing" title="الأسعار والتكلفة" open={sections.pricing} onToggle={() => toggleSection('pricing')}
                summary={form.base_price ? `بيع ${formatDzd(form.base_price)}` : 'السعر غير محدد'}>
                <div className="grid grid-cols-2 gap-2">
                <label className="block">
                  <span className="mb-1 block text-xs text-neutral-400">سعر البيع</span>
                  <input
                    type="number"
                    min="0"
                    value={form.base_price}
                    onChange={(e) => setForm({ ...form, base_price: e.target.value })}
                    className="w-full rounded-lg border border-neutral-700 bg-[#141414] px-3 py-2 text-sm outline-none focus:border-gold"
                  />
                </label>
                <label className="block">
                  <span className="mb-1 block text-xs text-neutral-400">سعر التكلفة</span>
                  <input
                    type="number"
                    min="0"
                    value={form.cost_price}
                    onChange={(e) => setForm({ ...form, cost_price: e.target.value })}
                    className="w-full rounded-lg border border-neutral-700 bg-[#141414] px-3 py-2 text-sm outline-none focus:border-gold"
                  />
                </label>
                </div>
              </ProductSection>

              <ProductSection id="barcode" title="الباركود" open={sections.barcode} onToggle={() => toggleSection('barcode')}
                summary={form.barcode.trim() || 'توليد تلقائي عند الحفظ'}>
                <div className="space-y-3">
                  <div>
                    <label htmlFor="product-barcode" className="mb-2 block text-xs text-neutral-400">باركود الموديل العام · اختياري</label>
                    <div className="flex gap-2">
                      <input id="product-barcode" data-barcode-input="product-barcode" dir="ltr" maxLength={64} value={form.barcode} disabled={saving || generating}
                        placeholder={generating ? 'جاري التوليد…' : 'الباركود'}
                        onChange={e => setForm(prev => ({ ...prev, barcode: e.target.value }))}
                        className="min-w-0 flex-1 rounded-lg border border-neutral-700 bg-[#141414] px-3 py-2 font-mono text-sm outline-none focus:border-gold disabled:opacity-50" />
                      <button type="button" disabled={saving || generating} onClick={() => setScanning('entry')} title="مسح الباركود بالكاميرا" aria-label="مسح الباركود بالكاميرا"
                        className="rounded-lg border border-gold/30 bg-gold/10 px-3 text-gold disabled:opacity-50">
                        <svg aria-hidden="true" viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.7"><path d="M3 8V3h5M16 3h5v5M21 16v5h-5M8 21H3v-5M7 8v8M10 8v8M14 8v8M17 8v8" /></svg>
                      </button>
                    </div>
                    <div className="mt-2 flex items-start justify-between gap-3">
                      <p className="text-[11px] text-neutral-500">هذا الرمز يفتح اختيار اللون والمقاس في الكاشير. اتركه فارغاً إن لم تحتج باركود موديل. رموز التركيبات الفارغة تُولّد عند الحفظ.</p>
                      <button type="button" disabled={saving || generating} onClick={regenerateBarcode} className="shrink-0 text-xs text-gold disabled:opacity-50">توليد جديد</button>
                    </div>
                  </div>
                  <fieldset className="space-y-3 rounded-xl border border-gold/20 bg-[#171717] p-3">
                    <legend className="px-2 text-sm text-gold">باركودات التركيبات · اختيارية</legend>
                    <p className="text-xs text-neutral-400">أدخل رمزاً لكل لون/مقاس ذي كمية، أو اتركه فارغاً للتوليد الذري عند الحفظ. الرموز المحفوظة ثابتة لحماية الملصقات.</p>
                    {colorRows.flatMap(color => sizes.filter(size => Number(matrix[color]?.[size]) > 0).map(size => {
                      const key = barcodeCellKey(color, size)
                      return <div key={key} className="flex items-center gap-2">
                        <label className="flex-1 text-xs text-neutral-300">{color} / {sizeLabel(size)}
                          <input data-barcode-input="variant-code" data-variant-barcode-key={key} dir="ltr" aria-label={`باركود ${color} ${size}`} maxLength={64} disabled={saving} value={variantBarcodes[key] || ''} onChange={e => setVariantBarcodes(prev => ({ ...prev, [key]: e.target.value }))} placeholder="توليد تلقائي عند الحفظ" className="mt-1 w-full rounded-lg border border-neutral-700 bg-[#141414] px-3 py-2 font-mono text-sm" />
                        </label>
                        <button type="button" disabled={saving} onClick={() => setScanning(`variant:${key}`)} aria-label={`مسح باركود ${color} ${size}`} className="rounded-lg border border-gold/30 px-3 py-2 text-xs text-gold">مسح</button>
                      </div>
                    }))}
                  </fieldset>
                </div>
              </ProductSection>

              <ProductSection id="media" title="الصور ومحتوى المتجر الإلكتروني" open={sections.media} onToggle={() => toggleSection('media')}
                summary={form.imagePreview || form.imageFile ? 'تم اختيار صورة' : 'الصورة إلزامية'}>
                <div className="space-y-3">
                  <div>
                    <button type="button" onClick={() => cameraInput.current?.click()} className="rounded-lg border border-gold/30 px-3 py-2 text-sm text-gold">التقاط صورة</button>
                    <input ref={cameraInput} type="file" accept="image/*" capture="environment" className="hidden" onChange={e => {
                      const file = e.target.files?.[0]
                      if (file) setForm(prev => ({ ...prev, imageFile: file, imagePreview: URL.createObjectURL(file) }))
                    }} />
                    <label className="mt-3 block">
                      <span className="mb-1 block text-xs text-neutral-400">صورة المنتج</span>
                      <input
                        type="file"
                        accept="image/*"
                        onChange={(e) => {
                          const file = e.target.files?.[0] || null
                          setForm({
                            ...form,
                            imageFile: file,
                            imagePreview: file ? URL.createObjectURL(file) : '',
                          })
                        }}
                        className="w-full text-xs text-neutral-400"
                      />
                      {form.imagePreview && (
                        <img src={form.imagePreview} alt="" className="mt-2 h-20 w-20 rounded-lg object-cover" />
                      )}
                    </label>
                  </div>

                  <label className="block">
                    <span className="mb-1 block text-xs text-neutral-400">رابط فيديو المنتج (تيك توك / إنستغرام / فيسبوك)</span>
                    <input
                      type="url"
                      dir="ltr"
                      inputMode="url"
                      value={form.external_video_url}
                      onChange={(e) => setForm({ ...form, external_video_url: e.target.value })}
                      placeholder="https://www.tiktok.com/@shop/video/..."
                      className="w-full rounded-lg border border-neutral-700 bg-[#141414] px-3 py-2 text-start text-sm outline-none focus:border-gold"
                    />
                    <span className="mt-1 block text-[11px] text-neutral-500">
                      يظهر زر «شاهد الفيديو» في المتجر العام. اتركه فارغاً إن لم يكن هناك فيديو.
                    </span>
                  </label>
                </div>
              </ProductSection>
            </div>
            {error && <p className="mt-3 text-xs text-red-300">{error}</p>}

            <button
              type="submit"
              disabled={saving || generating || saveUncertain}
              className="mt-4 w-full rounded-lg bg-gold py-2.5 text-sm font-medium text-[#121212] disabled:opacity-60"
            >
              {saving ? 'جاري الحفظ...' : 'حفظ المنتج'}
            </button>
          </form>
        </div>
      )}
      {scanning && <BarcodeScanner confirmLabel="استخدام الباركود" onClose={() => setScanning(false)} onScan={code => {
        validateBarcode(code)
        if (scanning === 'search') setSearch(code)
        else if (String(scanning).startsWith('variant:')) setVariantBarcodes(prev => ({ ...prev, [scanning.slice(8)]: code }))
        else setForm(prev => ({ ...prev, barcode: code }))
      }} />}
    </>
  )
}
