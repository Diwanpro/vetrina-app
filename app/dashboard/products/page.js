'use client'

import { useEffect, useState } from 'react'
import { variantBarcodes } from '@/lib/engine'
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
        .select('id, name, description, category, base_price, images, image_url, product_variants(id, barcode, color, size, inventory(quantity, store_id))')
        .eq('tenant_id', context.tenantId).order('created_at', { ascending: false }).order('id'))
      setProducts(rows)
    } catch (err) { setError(err.message) }
    finally { setLoading(false) }
  }

  useEffect(() => { loadProducts() }, [])

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
    if (saving) return
    setError('')
    let filledCells
    let barcodes
    try {
      filledCells = filledSizeCells(matrix, sizes)
      barcodes = variantBarcodes(form.barcode, filledCells.length)
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
          onClick={() => setOpen(true)}
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
              <button type="button" onClick={() => setOpen(false)} className="text-xs text-neutral-400">
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
              <label className="block">
                <span className="mb-1 block text-xs text-neutral-400">الوصف</span>
                <textarea
                  value={form.description}
                  onChange={(e) => setForm({ ...form, description: e.target.value })}
                  rows={2}
                  className="w-full rounded-lg border border-neutral-700 bg-[#141414] px-3 py-2 text-sm outline-none focus:border-gold"
                />
              </label>
              <label className="block">
                <span className="mb-1 block text-xs text-neutral-400">الباركود الأساسي (اختياري)</span>
                <input dir="ltr" maxLength={48} value={form.barcode} disabled={saving}
                  onChange={e => setForm({ ...form, barcode: e.target.value })}
                  className="w-full rounded-lg border border-neutral-700 bg-[#141414] px-3 py-2 text-sm outline-none focus:border-gold" />
                <span className="mt-1 block text-[11px] text-neutral-500">لمقاس واحد يُحفظ كما هو؛ لعدة مقاسات تضاف لاحقة مثل -01 لكل مقاس. اتركه فارغاً لتوليد رموز فريدة تلقائياً.</span>
              </label>
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
              disabled={saving}
              className="mt-4 w-full rounded-lg bg-gold py-2.5 text-sm font-medium text-[#121212] disabled:opacity-60"
            >
              {saving ? 'جاري الحفظ...' : 'حفظ المنتج'}
            </button>
          </form>
        </div>
      )}
    </DashboardShell>
  )
}
