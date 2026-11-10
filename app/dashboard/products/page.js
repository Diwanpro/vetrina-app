'use client'

import { useEffect, useRef, useState } from 'react'
import VoiceInput from '@/components/VoiceInput'
import BarcodeScanner from '@/components/dashboard/BarcodeScanner'
import { fetchAllRows } from '@/lib/cash'
import DashboardShell from '@/components/dashboard/DashboardShell'
import { SIZE_TYPES, sizesForType, emptySizeRow, emptySizeMatrix, filledSizeCells } from '@/lib/product-sizes'
import { supabase } from '@/lib/supabase'
import { formatDzd, getAppContext } from '@/lib/app-context'

const CATEGORIES = ['ملابس', 'أحذية', 'إكسسوارات']
const DEFAULT_COLORS = ['أبيض', 'أسود', 'أزرق', 'أحمر', 'بيج']
function firstImage(product) {
  if (Array.isArray(product.images) && product.images.length) return product.images[0]
  return product.image_url || ''
}

export default function ProductsPage() {
  const [products, setProducts] = useState([])
  const [loading, setLoading] = useState(true)
  const [open, setOpen] = useState(false)
  const [scanning, setScanning] = useState(false)
  const [generating, setGenerating] = useState(false)
  const barcodeTask = useRef(0)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [ctx, setCtx] = useState({ tenantId: null, storeId: null })
  const [form, setForm] = useState({
    name: '',
    description: '',
    category: CATEGORIES[0],
    base_price: '',
    cost_price: '',
    barcode: '',
    imageFile: null,
    imagePreview: '',
  })
  const [sizeType, setSizeType] = useState(SIZE_TYPES[0].value)
  const sizes = sizesForType(sizeType)
  const [matrix, setMatrix] = useState(() => emptySizeMatrix(DEFAULT_COLORS, sizesForType(SIZE_TYPES[0].value)))
  const [newColor, setNewColor] = useState('')

  async function loadProducts() {
    setLoading(true)
    try {
      const context = await getAppContext()
      if (!context.tenantId || !context.storeId) throw new Error('تعذر تحديد المتجر')
      setCtx(context)
      const rows = await fetchAllRows(supabase.from('products')
        .select('id, name, description, category, base_price, images, image_url, product_variants!inner(id, barcode, color, size, inventory!inner(quantity, store_id))')
        .eq('tenant_id', context.tenantId).eq('product_variants.inventory.store_id', context.storeId).order('created_at', { ascending: false }).order('id'))
      setProducts(rows)
    } catch (err) { setError(err.message) }
    finally { setLoading(false) }
  }

  useEffect(() => { loadProducts(); return () => { barcodeTask.current += 1 } }, [])

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
  function openProductForm() {
    setOpen(true); setError('')
    if (!form.barcode) regenerateBarcode()
  }
  function closeProductForm() {
    if (saving) return
    barcodeTask.current += 1; setGenerating(false); setOpen(false)
  }

  const colorRows = Object.keys(matrix)

  function changeSizeType(type) {
    if (type === sizeType) return
    setSizeType(type)
    // Reset all quantities, including overlapping numeric sizes, so shoe stock
    // can never silently become pants stock (or vice versa).
    setMatrix(prev => emptySizeMatrix(Object.keys(prev), sizesForType(type)))
    setError('')
  }

  function addCustomColor() {
    const color = newColor.trim()
    if (!color) return
    if (matrix[color]) {
      setError('هذا اللون موجود مسبقاً')
      return
    }
    setError('')
    setMatrix((prev) => ({ ...prev, [color]: emptySizeRow(sizes) }))
    setNewColor('')
  }

  async function handleSave(e) {
    e.preventDefault()
    if (saving || generating) return
    setError('')
    let filledCells
    let barcodes
    try {
      filledCells = filledSizeCells(matrix, sizes)
      if (form.barcode.trim() && !/^[\x21-\x7E]{1,48}$/.test(form.barcode.trim())) throw new Error('الباركود يجب أن يحتوي على حروف لاتينية أو أرقام أو رموز دون مسافات (حتى 48 حرفاً)')
    } catch (err) {
      setError(err.message)
      return
    }
    if (!form.name.trim() || !form.base_price) {
      setError('يرجى إدخال اسم المنتج وسعر البيع')
      return
    }
    if (!ctx.tenantId || !ctx.storeId) {
      setError('لا يمكن الحفظ: لم يتم العثور على المتجر أو المؤسسة')
      return
    }
    if (!filledCells.length) {
      setError('أدخل كمية واحدة على الأقل في جدول المقاسات')
      return
    }

    setSaving(true)
    try {
      const first = form.barcode.trim() || (await allocateBarcodes(1))[0]
      barcodes = [first, ...await allocateBarcodes(filledCells.length - 1)]
      // Check external/scanned codes before creating a product. The database
      // UNIQUE constraint remains the final protection against concurrent writes.
      const { data: duplicates, error: lookupError } = await supabase.from('product_variants')
        .select('id, products!inner(tenant_id), inventory!inner(store_id)').eq('products.tenant_id', ctx.tenantId).eq('inventory.store_id', ctx.storeId).in('barcode', barcodes).limit(1)
      if (lookupError) throw lookupError
      if (duplicates?.length) throw new Error('هذا الباركود مستخدم مسبقاً. امسح رمزاً آخر أو اضغط توليد جديد.')
    } catch (err) { setSaving(false); setError(err.message); return }
    let images = []
    if (form.imageFile) {
      const ext = (form.imageFile.name.split('.').pop() || 'jpg').toLowerCase().replace(/[^a-z0-9]/g, '') || 'jpg'
      const path = `${ctx.tenantId}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`
      const { error: upErr } = await supabase.storage.from('products').upload(path, form.imageFile, {
        cacheControl: '3600',
        upsert: true,
        contentType: form.imageFile.type || 'image/jpeg',
      })
      if (upErr) {
        setSaving(false)
        setError(upErr.message || 'فشل رفع الصورة')
        return
      }
      const { data: pub } = supabase.storage.from('products').getPublicUrl(path)
      if (pub?.publicUrl) images = [pub.publicUrl]
    }

    const { data: product, error: pErr } = await supabase
      .from('products')
      .insert({
        tenant_id: ctx.tenantId,
        name: form.name.trim(),
        description: form.description.trim() || null,
        category: form.category,
        base_price: Number(form.base_price),
        type: 'variable',
        images,
        image_url: images[0] || null,
        is_active: true,
      })
      .select('id')
      .single()

    if (pErr || !product) {
      setSaving(false)
      setError(pErr?.message || 'فشل حفظ المنتج')
      return
    }

    const costPrice = Number(form.cost_price || 0)
    const variants = filledCells.map((cell, index) => ({
      barcode: barcodes[index],
      product_id: product.id,
      color: cell.color,
      size: cell.size,
      sku: `${form.name.trim().slice(0, 8)}-${cell.color}-${cell.size}`.replace(/\s+/g, ''),
      cost_price_avg: costPrice,
    }))

    const { data: createdVariants, error: vErr } = await supabase
      .from('product_variants')
      .insert(variants)
      .select('id, color, size')

    if (vErr || !createdVariants) {
      setSaving(false)
      setError(vErr?.message || 'فشل حفظ المقاسات')
      return
    }

    const inventoryRows = createdVariants.map((v) => {
      const cell = filledCells.find((c) => c.color === v.color && c.size === v.size)
      return {
        store_id: ctx.storeId,
        variant_id: v.id,
        quantity: cell?.qty || 0,
      }
    })

    const { error: iErr } = await supabase.from('inventory').insert(inventoryRows)
    setSaving(false)

    if (iErr) {
      setError(iErr.message || 'فشل حفظ المخزون')
      return
    }

    setOpen(false)
    setForm({ name: '', description: '', category: CATEGORIES[0], base_price: '', cost_price: '', barcode: '', imageFile: null, imagePreview: '' })
    setSizeType(SIZE_TYPES[0].value)
    setMatrix(emptySizeMatrix(DEFAULT_COLORS, sizesForType(SIZE_TYPES[0].value)))
    setNewColor('')
    loadProducts()
  }

  return (
    <DashboardShell active="/dashboard/products">
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

      {!open && error && <p role="alert" className="mb-3 text-sm text-red-300">{error}</p>}
      {loading ? (
        <p className="text-sm text-neutral-500">جاري التحميل...</p>
      ) : products.length === 0 ? (
        <div className="rounded-xl border border-dashed border-white/10 bg-card p-8 text-center">
          <p className="text-sm text-neutral-300">لا توجد منتجات بعد</p>
          <p className="mt-1 text-xs text-neutral-500">أضف أول منتج لبدء نقطة البيع</p>
        </div>
      ) : (
        <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-4 gap-2.5">
          {products.map((p) => {
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
                  <p className="text-[11px] text-neutral-500">{p.category || '—'}</p>
                  <a href={`/dashboard/products/barcodes?product=${encodeURIComponent(p.id)}`} target="_blank" rel="noopener noreferrer"
                    className="mt-2 mb-2 block rounded-lg border border-gold/20 px-2 py-1.5 text-center text-xs text-gold">طباعة الباركود</a>
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
              <label className="block">
                <span className="mb-1 block text-xs text-neutral-400">اسم المنتج</span>
                <input
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                  className="w-full rounded-lg border border-neutral-700 bg-[#141414] px-3 py-2 text-sm outline-none focus:border-gold"
                  required
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
              <div>
                <label htmlFor="product-barcode" className="mb-2 block text-xs text-neutral-400">الباركود · يُولّد تلقائياً</label>
                <div className="flex gap-2">
                  <input id="product-barcode" dir="ltr" maxLength={48} value={form.barcode} disabled={saving || generating}
                    placeholder={generating ? 'جاري التوليد…' : 'الباركود'}
                    onChange={e => setForm(prev => ({ ...prev, barcode: e.target.value }))}
                    className="min-w-0 flex-1 rounded-lg border border-neutral-700 bg-[#141414] px-3 py-2 font-mono text-sm outline-none focus:border-gold disabled:opacity-50" />
                  <button type="button" disabled={saving || generating} onClick={() => setScanning(true)} title="مسح الباركود بالكاميرا" aria-label="مسح الباركود بالكاميرا"
                    className="rounded-lg border border-gold/30 bg-gold/10 px-3 text-gold disabled:opacity-50">
                    <svg aria-hidden="true" viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.7"><path d="M3 8V3h5M16 3h5v5M21 16v5h-5M8 21H3v-5M7 8v8M10 8v8M14 8v8M17 8v8" /></svg>
                  </button>
                </div>
                <div className="mt-2 flex items-start justify-between gap-3">
                  <p className="text-[11px] text-neutral-500">رمز رقمي فريد من 12 خانة افتراضياً. يُحفظ الرمز الظاهر لأول مقاس، وتُولّد رموز مستقلة لباقي المقاسات.</p>
                  <button type="button" disabled={saving || generating} onClick={regenerateBarcode} className="shrink-0 text-xs text-gold disabled:opacity-50">توليد جديد</button>
                </div>
              </div>
              <label className="block">
                <span className="mb-1 block text-xs text-neutral-400">نوع المقاس</span>
                <select value={sizeType} disabled={saving} onChange={e => changeSizeType(e.target.value)}
                  aria-describedby="size-type-help"
                  className="w-full rounded-lg border border-neutral-700 bg-[#141414] px-3 py-2 text-sm outline-none focus:border-gold disabled:opacity-50">
                  {SIZE_TYPES.map(option => (
                    <option key={option.value} value={option.value}>{option.label} ({option.sizes.join(', ')})</option>
                  ))}
                </select>
                <span id="size-type-help" className="mt-1 block text-[11px] text-neutral-500">تغيير نوع المقاس يمسح كميات الجدول. أدخل الكميات بعد اختيار النوع.</span>
              </label>
              <label className="block">
                <span className="mb-1 block text-xs text-neutral-400">التصنيف</span>
                <select
                  value={form.category}
                  onChange={(e) => setForm({ ...form, category: e.target.value })}
                  className="w-full rounded-lg border border-neutral-700 bg-[#141414] px-3 py-2 text-sm outline-none focus:border-gold"
                >
                  {CATEGORIES.map((c) => (
                    <option key={c}>{c}</option>
                  ))}
                </select>
              </label>
              <div className="grid grid-cols-2 gap-2">
                <label className="block">
                  <span className="mb-1 block text-xs text-neutral-400">سعر البيع</span>
                  <input
                    type="number"
                    min="0"
                    value={form.base_price}
                    onChange={(e) => setForm({ ...form, base_price: e.target.value })}
                    className="w-full rounded-lg border border-neutral-700 bg-[#141414] px-3 py-2 text-sm outline-none focus:border-gold"
                    required
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
              <label className="block">
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

              <div>
                <p className="mb-1.5 text-xs text-neutral-400">المخزون حسب اللون والمقاس</p>
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
                          <th key={s} className="p-2">{s}</th>
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
                                aria-label={`كمية ${color} مقاس ${size}`}
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

            {error && <p className="mt-3 text-xs text-red-300">{error}</p>}

            <button
              type="submit"
              disabled={saving || generating}
              className="mt-4 w-full rounded-lg bg-gold py-2.5 text-sm font-medium text-[#121212] disabled:opacity-60"
            >
              {saving ? 'جاري الحفظ...' : 'حفظ المنتج'}
            </button>
          </form>
        </div>
      )}
      {scanning && <BarcodeScanner confirmLabel="استخدام الباركود" onClose={() => setScanning(false)} onScan={code => {
        if (!/^[\x21-\x7E]{1,48}$/.test(code)) throw new Error('الباركود غير صالح لهذا الحقل')
        setForm(prev => ({ ...prev, barcode: code }))
      }} />}
    </DashboardShell>
  )
}
