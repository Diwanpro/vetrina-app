'use client'

import { useEffect, useMemo, useState } from 'react'
import { logAction } from '@/lib/audit'
import { meetsFloor, validMoney, FLOOR_PRICE_MESSAGE } from '@/lib/cash'
import DashboardShell from '@/components/dashboard/DashboardShell'
import { supabase } from '@/lib/supabase'
import { formatDzd, getAppContext } from '@/lib/app-context'

const PAYMENTS = [
  { value: 'cash', label: 'نقداً' },
  { value: 'check', label: 'شيك' },
  { value: 'ccp', label: 'CCP' },
]

function firstImage(product) {
  if (Array.isArray(product.images) && product.images.length) return product.images[0]
  return product.image_url || ''
}

export default function PosPage() {
  const [products, setProducts] = useState([])
  const [loading, setLoading] = useState(true)
  const [ctx, setCtx] = useState({ tenantId: null, storeId: null, user: null })
  const [selected, setSelected] = useState(null)
  const [picked, setPicked] = useState({ color: '', size: '' })
  const [cart, setCart] = useState([])
  const [checkout, setCheckout] = useState(false)
  const [payment, setPayment] = useState('cash')
  const [cashPaid, setCashPaid] = useState('')
  const [creditPaid, setCreditPaid] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [done, setDone] = useState('')
  const [editing, setEditing] = useState(null)
  const [draftPrice, setDraftPrice] = useState('')
  const [draftDiscount, setDraftDiscount] = useState('')
  const [priceBusy, setPriceBusy] = useState(false)
  const [priceError, setPriceError] = useState('')

  async function loadProducts() {
    setLoading(true)
    const { data } = await supabase
      .from('products')
      .select('id, name, base_price, images, image_url, product_variants(id, color, size, min_price, inventory(quantity, store_id))')
      .eq('is_active', true)
      .order('created_at', { ascending: false })
    setProducts(data || [])
    setLoading(false)
  }

  useEffect(() => {
    getAppContext().then(setCtx)
    loadProducts()
  }, [])

  const available = useMemo(() => {
    if (!selected) return []
    return (selected.product_variants || [])
      .map((v) => ({
        ...v,
        qty: (v.inventory || [])
          .filter((i) => !ctx.storeId || i.store_id === ctx.storeId)
          .reduce((s, i) => s + Number(i.quantity || 0), 0),
      }))
      .filter((v) => v.qty > 0)
  }, [selected, ctx.storeId])

  const colors = [...new Set(available.map((v) => v.color))]
  const sizes = available.filter((v) => !picked.color || v.color === picked.color)

  const totals = useMemo(() => {
    const count = cart.reduce((s, i) => s + i.qty, 0)
    const amount = cart.reduce((s, i) => s + i.qty * i.price, 0)
    return { count, amount }
  }, [cart])

  function addToCart() {
    const variant = available.find((v) => v.color === picked.color && v.size === picked.size)
    if (!variant) return
    setCart((prev) => {
      const existing = prev.find((i) => i.variantId === variant.id)
      if (existing) {
        return prev.map((i) =>
          i.variantId === variant.id ? { ...i, qty: Math.min(i.qty + 1, variant.qty) } : i
        )
      }
      return [
        ...prev,
        {
          variantId: variant.id,
          name: selected.name,
          color: variant.color,
          size: variant.size,
          price: Number(selected.base_price || 0),
          originalPrice: Number(selected.base_price || 0),
          minPrice: Number(variant.min_price || 0),
          qty: 1,
          max: variant.qty,
        },
      ]
    })
    setSelected(null)
    setPicked({ color: '', size: '' })
  }

  async function applyPrice(event) {
    event.preventDefault()
    if (priceBusy || !editing) return
    setPriceError('')
    if (!validMoney(draftPrice) || !validMoney(draftDiscount) || Number(draftDiscount) > 100) {
      setPriceError('أدخل سعراً صحيحاً وخصماً بين 0 و100')
      return
    }
    const newPrice = Math.round(Number(draftPrice) * (1 - Number(draftDiscount) / 100))
    if (!meetsFloor(newPrice, editing.minPrice)) {
      setPriceError(FLOOR_PRICE_MESSAGE)
      return
    }
    setPriceBusy(true)
    try {
      const { data, error } = await supabase.from('product_variants').select('min_price').eq('id', editing.variantId).single()
      if (error) throw error
      if (!meetsFloor(newPrice, data.min_price)) throw new Error(FLOOR_PRICE_MESSAGE)
      if (newPrice !== editing.price) {
        await logAction('pos_price_changed', {
          variant_id: editing.variantId, product_name: editing.name,
          old_price: editing.price, new_price: newPrice,
          discount_percent: Number(draftDiscount), source: 'pos_cart',
        })
        setCart(prev => prev.map(item => item.variantId === editing.variantId
          ? { ...item, price: newPrice, minPrice: Number(data.min_price || 0) } : item))
      }
      setEditing(null)
    } catch (err) { setPriceError(err.message || 'تعذر تسجيل تعديل السعر') }
    finally { setPriceBusy(false) }
  }

  async function completeSale() {
    setError('')
    if (!cart.length || saving || priceBusy) return
    if (!ctx.storeId) {
      setError('لم يتم العثور على المتجر')
      return
    }
    setSaving(true)
    // Refresh floors at checkout too: another user may have changed them.
    try {
      const { data: variants, error: floorError } = await supabase.from('product_variants')
        .select('id, min_price').in('id', cart.map(item => item.variantId))
      if (floorError) throw floorError
      if (!variants || cart.some(item => {
        const variant = variants.find(v => v.id === item.variantId)
        return !variant || !meetsFloor(item.price, variant.min_price)
      })) throw new Error(FLOOR_PRICE_MESSAGE)
    } catch (err) {
      setError(err.message)
      setSaving(false)
      return
    }

    const { data: sale, error: sErr } = await supabase
      .from('sales')
      .insert({
        store_id: ctx.storeId,
        user_id: ctx.user?.id || null,
        total_amount: totals.amount,
        payment_method: payment,
        status: 'completed',
      })
      .select('id')
      .single()

    if (sErr || !sale) {
      setSaving(false)
      setError(sErr?.message || 'فشل إنشاء الفاتورة')
      return
    }

    const items = cart.map((i) => ({
      sale_id: sale.id,
      variant_id: i.variantId,
      quantity: i.qty,
      original_price: i.originalPrice,
      final_price: i.price,
      unit_price: i.price,
      subtotal: i.price * i.qty,
    }))

    const { error: iErr } = await supabase.from('sale_items').insert(items)
    if (iErr) {
      setSaving(false)
      setError(iErr.message)
      return
    }

    for (const item of cart) {
      const { data: inv } = await supabase
        .from('inventory')
        .select('id, quantity')
        .eq('variant_id', item.variantId)
        .eq('store_id', ctx.storeId)
        .maybeSingle()
      if (inv) {
        await supabase
          .from('inventory')
          .update({ quantity: Math.max(0, Number(inv.quantity) - item.qty) })
          .eq('id', inv.id)
      }
    }

    setSaving(false)
    setCart([])
    setCheckout(false)
    setCashPaid('')
    setCreditPaid('')
    setDone('تمت عملية البيع بنجاح')
    loadProducts()
    setTimeout(() => setDone(''), 2500)
  }

  return (
    <DashboardShell active="/dashboard/pos">
      <div className="mb-3 flex items-center justify-between">
        <h1 className="text-base font-medium text-neutral-100">نقطة البيع</h1>
        <span className="text-xs text-neutral-500">{products.length} منتج</span>
      </div>

      {loading ? (
        <p className="text-sm text-neutral-500">جاري التحميل...</p>
      ) : products.length === 0 ? (
        <p className="text-sm text-neutral-500">لا توجد منتجات. أضف منتجات أولاً.</p>
      ) : (
        <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-4 gap-2 pb-20">
          {products.map((p) => {
            const img = firstImage(p)
            return (
              <button
                key={p.id}
                type="button"
                onClick={() => {
                  setSelected(p)
                  setPicked({ color: '', size: '' })
                }}
                className="rounded-xl border border-white/5 bg-card overflow-hidden text-right"
              >
                <div className="aspect-square bg-[#222] flex items-center justify-center">
                  {img ? (
                    <img src={img} alt={p.name} className="h-full w-full object-cover" />
                  ) : (
                    <span className="text-xs text-neutral-500">بدون صورة</span>
                  )}
                </div>
                <div className="p-2">
                  <p className="text-sm text-neutral-100 truncate">{p.name}</p>
                  <p className="text-sm font-medium text-gold">{formatDzd(p.base_price)}</p>
                </div>
              </button>
            )
          })}
        </div>
      )}

      {selected && (
        <div className="fixed inset-0 z-50 bg-black/70 flex items-end md:items-center justify-center p-0 md:p-4">
          <div className="w-full max-w-sm max-h-[90vh] overflow-y-auto rounded-t-2xl md:rounded-2xl bg-[#171717] border border-white/10 p-4">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-sm font-medium">{selected.name}</h2>
              <button type="button" onClick={() => setSelected(null)} className="text-xs text-neutral-400">
                إغلاق
              </button>
            </div>
            {available.length === 0 ? (
              <p className="text-sm text-neutral-500">لا يوجد مخزون متاح</p>
            ) : (
              <>
                <p className="mb-1 text-xs text-neutral-400">اللون</p>
                <div className="mb-3 flex flex-wrap gap-1.5">
                  {colors.map((c) => (
                    <button
                      key={c}
                      type="button"
                      onClick={() => setPicked({ color: c, size: '' })}
                      className={`rounded-lg px-2.5 py-1.5 text-xs ${
                        picked.color === c ? 'bg-gold text-[#121212]' : 'bg-[#222] text-neutral-300'
                      }`}
                    >
                      {c}
                    </button>
                  ))}
                </div>
                <p className="mb-1 text-xs text-neutral-400">المقاس</p>
                <div className="mb-4 flex flex-wrap gap-1.5">
                  {sizes.map((v) => (
                    <button
                      key={v.id}
                      type="button"
                      onClick={() => setPicked({ color: v.color, size: v.size })}
                      className={`rounded-lg px-2.5 py-1.5 text-xs ${
                        picked.size === v.size && picked.color === v.color
                          ? 'bg-gold text-[#121212]'
                          : 'bg-[#222] text-neutral-300'
                      }`}
                    >
                      {v.size} ({v.qty})
                    </button>
                  ))}
                </div>
                <button
                  type="button"
                  disabled={!picked.color || !picked.size}
                  onClick={addToCart}
                  className="w-full rounded-lg bg-gold py-2.5 text-sm font-medium text-[#121212] disabled:opacity-50"
                >
                  إضافة للسلة
                </button>
              </>
            )}
          </div>
        </div>
      )}

      {cart.length > 0 && (
        <div className="fixed bottom-16 md:bottom-3 inset-x-3 md:inset-x-auto md:right-[100px] md:w-[360px] z-40 rounded-xl border border-gold/30 bg-[#171717] p-3 shadow-2xl">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-xs text-neutral-400">{totals.count} قطعة</p>
              <p className="text-base font-bold text-gold">{formatDzd(totals.amount)}</p>
            </div>
            <button
              type="button"
              onClick={() => setCheckout(true)}
              className="rounded-lg bg-gold px-4 py-2 text-sm font-medium text-[#121212]"
            >
              إتمام البيع
            </button>
          </div>
        </div>
      )}

      {checkout && (
        <div className="fixed inset-0 z-50 bg-black/70 flex items-end md:items-center justify-center p-0 md:p-4">
          <div className="w-full max-w-sm max-h-[90vh] overflow-y-auto rounded-t-2xl md:rounded-2xl bg-[#171717] border border-white/10 p-4">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-sm font-medium">إتمام البيع</h2>
              <button type="button" onClick={() => setCheckout(false)} className="text-xs text-neutral-400">
                إغلاق
              </button>
            </div>
            <ul className="mb-3 max-h-60 overflow-y-auto space-y-2 text-xs text-neutral-300">
              {cart.map((i) => (
                <li key={i.variantId} className="flex justify-between">
                  <span>
                    {i.name} · {i.color}/{i.size} × {i.qty}
                  </span>
                  <div className="text-left">
                    <span className="block text-gold">{formatDzd(i.price * i.qty)}</span>
                    <button type="button" disabled={saving || priceBusy} className="mt-1 text-gold underline disabled:opacity-50"
                      onClick={() => { setEditing(i); setDraftPrice(String(i.price)); setDraftDiscount('0'); setPriceError('') }}>
                      تعديل السعر / خصم
                    </button>
                  </div>
                </li>
              ))}
            </ul>
            <p className="mb-3 text-base font-bold text-gold">الإجمالي: {formatDzd(totals.amount)}</p>
            <label className="mb-2 block">
              <span className="mb-1 block text-xs text-neutral-400">طريقة الدفع</span>
              <select
                value={payment}
                onChange={(e) => setPayment(e.target.value)}
                className="w-full rounded-lg border border-neutral-700 bg-[#141414] px-3 py-2 text-sm outline-none focus:border-gold"
              >
                {PAYMENTS.map((p) => (
                  <option key={p.value} value={p.value}>
                    {p.label}
                  </option>
                ))}
              </select>
            </label>
            <div className="grid grid-cols-2 gap-2 mb-3">
              <label>
                <span className="mb-1 block text-xs text-neutral-400">المدفوع نقداً</span>
                <input
                  type="number"
                  min="0"
                  value={cashPaid}
                  onChange={(e) => setCashPaid(e.target.value)}
                  className="w-full rounded-lg border border-neutral-700 bg-[#141414] px-3 py-2 text-sm outline-none focus:border-gold"
                />
              </label>
              <label>
                <span className="mb-1 block text-xs text-neutral-400">المدفوع كريدي</span>
                <input
                  type="number"
                  min="0"
                  value={creditPaid}
                  onChange={(e) => setCreditPaid(e.target.value)}
                  className="w-full rounded-lg border border-neutral-700 bg-[#141414] px-3 py-2 text-sm outline-none focus:border-gold"
                />
              </label>
            </div>
            {error && <p className="mb-2 text-xs text-red-300">{error}</p>}
            <button
              type="button"
              disabled={saving}
              onClick={completeSale}
              className="w-full rounded-lg bg-gold py-2.5 text-sm font-medium text-[#121212] disabled:opacity-60"
            >
              {saving ? 'جاري الحفظ...' : 'إكمال البيع'}
            </button>
          </div>
        </div>
      )}

      {editing && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/80 p-4">
          <form onSubmit={applyPrice} role="dialog" aria-modal="true" aria-labelledby="price-title"
            className="w-full max-w-sm rounded-2xl border border-gold/30 bg-[#171717] p-5 shadow-2xl">
            <h2 id="price-title" className="mb-3 text-gold">تعديل سعر {editing.name}</h2>
            <p className="mb-3 text-xs text-neutral-400">السعر الحالي: {formatDzd(editing.price)}</p>
            <label className="mb-3 block text-sm">سعر الوحدة (دج)
              <input autoFocus required type="number" min="0" step="1" disabled={priceBusy} value={draftPrice}
                onChange={e => setDraftPrice(e.target.value)} className="mt-1 w-full rounded-lg border border-neutral-700 bg-black/20 p-2 outline-none focus:border-gold" />
            </label>
            <label className="mb-3 block text-sm">الخصم على السعر المدخل (%)
              <input required type="number" min="0" max="100" step="1" disabled={priceBusy} value={draftDiscount}
                onChange={e => setDraftDiscount(e.target.value)} className="mt-1 w-full rounded-lg border border-neutral-700 bg-black/20 p-2 outline-none focus:border-gold" />
            </label>
            {priceError && <p role="alert" className="mb-3 rounded-lg border border-gold/30 bg-gold/5 p-3 text-sm text-gold">{priceError}</p>}
            <div className="flex gap-2">
              <button disabled={priceBusy} className="flex-1 rounded-lg bg-gold p-2 text-black disabled:opacity-50">{priceBusy ? 'جاري التسجيل...' : 'تطبيق'}</button>
              <button type="button" disabled={priceBusy} onClick={() => setEditing(null)} className="rounded-lg border border-white/10 p-2 text-neutral-300">إلغاء</button>
            </div>
          </form>
        </div>
      )}

      {done && (
        <div className="fixed top-4 left-1/2 z-50 -translate-x-1/2 rounded-lg bg-emerald-900/90 px-4 py-2 text-sm text-emerald-100">
          {done}
        </div>
      )}
    </DashboardShell>
  )
}
