'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { isNetworkError } from '@/lib/access'
import { cacheCatalog, cachedCatalog, syncPending } from '@/lib/sync'
import { persistLocalSale, localRows } from '@/lib/local-db'
import { logAction } from '@/lib/audit'
import { meetsFloor, validMoney, FLOOR_PRICE_MESSAGE } from '@/lib/cash'
import BarcodeScanner from '@/components/dashboard/BarcodeScanner'
import MixedPaymentModal from '@/components/dashboard/MixedPaymentModal'
import { fetchAllRows } from '@/lib/cash'
import DashboardShell from '@/components/dashboard/DashboardShell'
import { supabase } from '@/lib/supabase'
import { formatDzd, getAppContext } from '@/lib/app-context'
import CustomSelect from '@/components/ui/CustomSelect'

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
  const saleSaving = useRef(false)
  const [scanning, setScanning] = useState(false)
  const [loading, setLoading] = useState(true)
  const [ctx, setCtx] = useState({ tenantId: null, storeId: null, user: null })
  const [selected, setSelected] = useState(null)
  const [picked, setPicked] = useState({ color: '', size: '' })
  const [cart, setCart] = useState([])
  const [cartOpen, setCartOpen] = useState(false)
  const [checkout, setCheckout] = useState(false)
  const [payment, setPayment] = useState('cash')
  const [cashPaid, setCashPaid] = useState('')
  const [splitting, setSplitting] = useState(false)
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
    try {
      const context = await getAppContext()
      if (!context.tenantId || !context.storeId) throw new Error('تعذر تحديد المتجر')
      setCtx(context)
      if (!navigator.onLine || context.offline) { setProducts(await cachedCatalog(context)); return }
      await syncPending().catch(err => { console.error('[pos] catalogue sync failed', err) })
      const rows = await fetchAllRows(supabase.from('products')
        .select('id, name, base_price, images, image_url, product_variants!inner(id, color, size, min_price, barcode, inventory!inner(quantity, store_id))')
        .eq('tenant_id', context.tenantId).eq('product_variants.inventory.store_id', context.storeId).eq('is_active', true)
        .order('created_at', { ascending: false }).order('id'))
      setProducts(await cacheCatalog(context, rows))
    } catch (err) {
      if (isNetworkError(err)) {
        try { const context = await getAppContext(); setProducts(await cachedCatalog(context)); setError('تعذر الوصول للخادم؛ تستخدم الكتالوج المحلي المحفوظ.') }
        catch (cacheError) { setError(cacheError.message) }
      } else setError(err.message)
    }
    finally { setLoading(false) }
  }

  useEffect(() => { loadProducts() }, [])

  const available = useMemo(() => {
    if (!selected) return []
    return (selected.product_variants || [])
      .map((v) => ({
        ...v,
        qty: (v.inventory || [])
          .filter((i) => ctx.storeId && i.store_id === ctx.storeId)
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

  // Amount paid in cash and the remainder carried as credit. The schema only
  // stores one payment method per sale, so the split is validated here and the
  // credit remainder is recorded by the credits page instead of being dropped.
  const paidCash = Number(String(cashPaid).replace(/[^0-9]/g, '') || 0)
  const creditRemainder = Math.max(0, totals.amount - paidCash)

  function addVariant(product, variant, qty) {
    if (qty <= 0) throw new Error('هذا المقاس غير متوفر في المتجر الحالي')
    const existing = cart.find(item => item.variantId === variant.id)
    if (existing && existing.qty >= qty) throw new Error('تمت إضافة كامل المخزون المتاح لهذا المقاس')
    setCart(prev => {
      const found = prev.find(item => item.variantId === variant.id)
      if (found) return prev.map(item => item.variantId === variant.id
        ? { ...item, qty: Math.min(item.qty + 1, qty), max: qty } : item)
      return [...prev, {
        variantId: variant.id, name: product.name, color: variant.color, size: variant.size,
        price: Number(product.base_price || 0), originalPrice: Number(product.base_price || 0),
        minPrice: Number(variant.min_price || 0), qty: 1, max: qty,
      }]
    })
  }

  function addToCart() {
    const variant = available.find(v => v.color === picked.color && v.size === picked.size)
    if (!variant) return
    try {
      addVariant(selected, variant, variant.qty)
      // Close the picker and stay in the catalogue so the next item can be
      // added; the floating bar is the only way into the cart.
      setSelected(null); setPicked({ color: '', size: '' }); setError('')
      setCartOpen(false); setCheckout(false)
    } catch (err) { setError(err.message) }
  }

  async function scanBarcode(code) {
    const context = await getAppContext()
    if (!context.tenantId || !context.storeId) throw new Error('تعذر تحديد المتجر')
    const product = products.find(product => product.product_variants?.some(variant => variant.barcode === code || variant.id === code))
    const variant = product?.product_variants.find(variant => variant.barcode === code || variant.id === code)
    if (!variant) throw new Error('الباركود غير موجود في كتالوج هذا الفرع. حدّث الكتالوج أثناء الاتصال.')
    const qty = (variant.inventory || []).filter(row => row.store_id === context.storeId)
      .reduce((sum, row) => sum + Number(row.quantity || 0), 0)
    addVariant(product, variant, qty)
    setDone('تمت إضافة المقاس إلى السلة'); setError('')
    setTimeout(() => setDone(''), 2500)
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
      let data = { min_price: editing.minPrice }
      if (navigator.onLine && !ctx.offline) {
        const result = await supabase.from('product_variants').select('min_price, products!inner(tenant_id), inventory!inner(store_id)')
          .eq('id', editing.variantId).eq('products.tenant_id', ctx.tenantId).eq('inventory.store_id', ctx.storeId).single()
        if (result.error) throw result.error
        data = result.data
      }
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

  // A remainder above 100 DZD cannot silently become credit: the cashier is
  // asked how it will be settled, and a cheque needs its paper attached.
  function requestSale() {
    if (creditRemainder > 100) { setSplitting(true); return }
    completeSale(null)
  }

  async function completeSale(split = null) {
    if (!cart.length || saleSaving.current || priceBusy) return
    saleSaving.current = true; setSaving(true); setError('')
    try {
      const current = await getAppContext()
      if (current.locked || current.storeId !== ctx.storeId || current.user.id !== ctx.user.id) throw new Error('تغير الحساب أو الفرع. أعد تحميل نقطة البيع.')
      const row = await persistLocalSale(current, cart, payment, split)
      // The local transaction is durable before clearing the cart, even online.
      setCart([]); setCheckout(false); setCartOpen(false); setCashPaid(''); setSplitting(false)
      setDone('تم حفظ الفاتورة محلياً؛ بانتظار المزامنة')
      if (navigator.onLine) {
        // A failed sync used to be swallowed here, which is why a sale could be
        // "done" on screen while the dashboard stayed at zero.
        await syncPending().catch(err => { console.error('[pos] syncPending failed', err) })
        const saved = (await localRows()).find(value => value.local_id === row.local_id)
        if (saved?.status === 'error') console.error('[pos] sale sync error', saved.error, row.local_id)
        setDone(saved?.status === 'synced'
          ? 'تم البيع والمزامنة بنجاح'
          : `الفاتورة محفوظة محلياً لكنها لم تُزامَن بعد${saved?.error ? `: ${saved.error}` : ''}. راجع الإعدادات.`)
      }
      await loadProducts()
      setTimeout(() => setDone(''), 5000)
    } catch (err) { console.error('[pos] completeSale failed', err); setError(err.message || 'تعذر حفظ الفاتورة؛ السلة لم تُمسح') }
    finally { saleSaving.current = false; setSaving(false) }
  }

  return (
    <DashboardShell active="/dashboard/pos">
      <div className="mb-3 flex items-center justify-between">
        <h1 className="text-base font-medium text-neutral-100">نقطة البيع</h1>
        <div className="flex items-center gap-3">
          <span className="text-xs text-neutral-500">{products.length} منتج</span>
          <button type="button" disabled={saving || !ctx.storeId} onClick={() => setScanning(true)}
            className="rounded-lg border border-gold/30 bg-gold/10 px-3 py-2 text-sm text-gold disabled:opacity-50">مسح الباركود</button>
        </div>
      </div>

      {error && !checkout && <p role="alert" className="mb-3 text-sm text-red-300">{error}</p>}
      {scanning && <BarcodeScanner onScan={scanBarcode} onClose={() => setScanning(false)} />}
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
                  // Pre-select the first colour so the size chips are never
                  // filtered down to an empty list (which made the product
                  // impossible to add to the cart).
                  const inStock = (p.product_variants || []).filter(v =>
                    (v.inventory || []).some(i => i.store_id === ctx.storeId && Number(i.quantity) > 0))
                  setSelected(p)
                  setPicked({ color: inStock[0]?.color || '', size: '' })
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

      {splitting && <MixedPaymentModal ctx={ctx} remainder={creditRemainder}
        onCancel={() => setSplitting(false)}
        onConfirm={async (choice) => { await completeSale({ ...choice, cash: paidCash }) }} />}

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

      {/* Floating cart bar. Adding an item returns to the catalogue, so this is
          the only path into the cart and from there into payment. */}
      {cart.length > 0 && !cartOpen && !checkout && (
        <button
          type="button"
          onClick={() => setCartOpen(true)}
          aria-label={`عرض السلة، ${totals.count} قطعة، ${formatDzd(totals.amount)}`}
          className="fixed bottom-16 md:bottom-3 inset-x-3 md:inset-x-auto md:right-[100px] md:w-[380px] z-40 flex items-center justify-between gap-3 rounded-xl border border-gold/40 bg-gold px-4 py-3 text-[#121212] shadow-2xl active:scale-[0.99]"
        >
          <span className="text-sm font-bold">عرض السلة ({totals.count} قطع) - {formatDzd(totals.amount)}</span>
          <span aria-hidden="true" className="text-lg leading-none">‹</span>
        </button>
      )}

      {/* Cart step: review, change quantities, remove, then pay. */}
      {cartOpen && (
        <div className="fixed inset-0 z-50 bg-black/70 flex items-end md:items-center justify-center p-0 md:p-4">
          <div className="w-full max-w-sm max-h-[90vh] overflow-y-auto rounded-t-2xl md:rounded-2xl bg-[#171717] border border-white/10 p-4">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-sm font-medium text-neutral-100">السلة ({totals.count} قطع)</h2>
              <button type="button" onClick={() => setCartOpen(false)} className="text-xs text-neutral-400">
                متابعة التسوق
              </button>
            </div>

            {cart.length === 0 ? (
              <p className="py-6 text-center text-sm text-neutral-500">السلة فارغة.</p>
            ) : (
              <>
                <ul className="mb-3 max-h-[45vh] space-y-2 overflow-y-auto text-xs text-neutral-300">
                  {cart.map((i) => (
                    <li key={i.variantId} className="rounded-lg border border-white/5 bg-black/20 p-2">
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <p className="truncate text-neutral-100">{i.name}</p>
                          <p className="mt-0.5 text-[11px] text-neutral-500">{i.color} / {i.size}</p>
                        </div>
                        <span className="shrink-0 text-gold">{formatDzd(i.price * i.qty)}</span>
                      </div>
                      <div className="mt-2 flex items-center justify-between gap-2">
                        <div className="flex items-center gap-2">
                          <button type="button" aria-label={`إنقاص كمية ${i.name}`} disabled={saving || i.qty <= 1}
                            onClick={() => setCart(prev => prev.map(item => item.variantId === i.variantId ? { ...item, qty: item.qty - 1 } : item))}
                            className="rounded border border-white/10 px-2.5 py-1 disabled:opacity-30">−</button>
                          <span className="min-w-6 text-center text-neutral-100">{i.qty}</span>
                          <button type="button" aria-label={`زيادة كمية ${i.name}`} disabled={saving || i.qty >= i.max}
                            onClick={() => setCart(prev => prev.map(item => item.variantId === i.variantId ? { ...item, qty: Math.min(item.qty + 1, item.max) } : item))}
                            className="rounded border border-white/10 px-2.5 py-1 disabled:opacity-30">+</button>
                        </div>
                        <button type="button" disabled={saving}
                          onClick={() => {
                            const next = cart.filter(item => item.variantId !== i.variantId)
                            setCart(next)
                            if (!next.length) { setCartOpen(false); setCheckout(false) }
                          }}
                          className="text-red-300">حذف</button>
                      </div>
                    </li>
                  ))}
                </ul>

                <div className="mb-3 flex items-center justify-between border-t border-white/10 pt-3">
                  <span className="text-sm text-neutral-400">الإجمالي</span>
                  <span className="text-base font-bold text-gold">{formatDzd(totals.amount)}</span>
                </div>
                <div className="flex flex-wrap gap-2">
                  <button type="button" disabled={saving} onClick={() => { setCartOpen(false); setCheckout(true) }}
                    className="flex-1 rounded-lg bg-gold py-2.5 text-sm font-medium text-[#121212] disabled:opacity-60">
                    متابعة للدفع
                  </button>
                  <button type="button" disabled={saving} onClick={() => setCartOpen(false)}
                    className="rounded-lg border border-white/10 px-3 py-2.5 text-sm text-neutral-300 disabled:opacity-50">
                    متابعة التسوق
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {checkout && (
        <div className="fixed inset-0 z-50 bg-black/70 flex items-end md:items-center justify-center p-0 md:p-4">
          <div className="w-full max-w-sm max-h-[90vh] overflow-y-auto rounded-t-2xl md:rounded-2xl bg-[#171717] border border-white/10 p-4">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-sm font-medium">إتمام البيع</h2>
              <div className="flex items-center gap-3">
                {/* Back to the cart, so a wrong size is fixed without losing the sale. */}
                <button type="button" disabled={saving} onClick={() => { setCheckout(false); setCartOpen(true) }} className="text-xs text-gold disabled:opacity-50">
                  رجوع للسلة
                </button>
                <button type="button" disabled={saving} onClick={() => { setCheckout(false); setCartOpen(true) }} className="text-xs text-neutral-400 disabled:opacity-50">
                  إغلاق
                </button>
              </div>
            </div>
            <ul className="mb-3 max-h-60 overflow-y-auto space-y-2 text-xs text-neutral-300">
              {cart.map((i) => (
                <li key={i.variantId} className="flex justify-between">
                  <div>
                    <span>{i.name} · {i.color}/{i.size} × {i.qty}</span>
                    <div className="mt-2 flex items-center gap-3">
                      <button type="button" aria-label={`إنقاص كمية ${i.name}`} disabled={saving || i.qty <= 1} onClick={() => setCart(prev => prev.map(item => item.variantId === i.variantId ? { ...item, qty: item.qty - 1 } : item))} className="rounded border border-white/10 px-2 py-1 disabled:opacity-30">−</button>
                      <button type="button" aria-label={`زيادة كمية ${i.name}`} disabled={saving || i.qty >= i.max} onClick={() => setCart(prev => prev.map(item => item.variantId === i.variantId ? { ...item, qty: Math.min(item.qty + 1, item.max) } : item))} className="rounded border border-white/10 px-2 py-1 disabled:opacity-30">+</button>
                      <button type="button" disabled={saving} onClick={() => { const next = cart.filter(item => item.variantId !== i.variantId); setCart(next); if (!next.length) { setCheckout(false); setCartOpen(false) } }} className="text-red-300">حذف</button>
                    </div>
                  </div>
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
                <CustomSelect
                  value={payment}
                  onChange={e => setPayment(e)}
                  options={PAYMENTS.map(p => ({ label: p.label, value: p.value }))}
                  className="w-full rounded-lg border border-[#D4AF37]/40 bg-[#1A1A1A] px-3 py-2 text-sm text-white outline-none focus:border-gold"
                />
              </label>
            <div className="mb-3 space-y-2 rounded-lg border border-gold/20 bg-black/30 p-3">
              <p className="flex justify-between text-sm"><span className="text-neutral-400">الإجمالي</span><span className="text-gold">{formatDzd(totals.amount)}</span></p>
              <label className="block">
                <span className="mb-1 block text-xs text-neutral-400">المدفوع نقداً</span>
                <input
                  type="number"
                  min="0"
                  inputMode="numeric"
                  value={cashPaid}
                  onChange={(e) => setCashPaid(e.target.value)}
                  placeholder="0"
                  className="w-full rounded-lg border border-[#D4AF37]/40 bg-[#1A1A1A] px-3 py-2 text-sm text-white outline-none focus:border-gold"
                />
              </label>
              <div className="flex flex-wrap gap-2">
                <button type="button" onClick={() => setCashPaid(String(totals.amount))}
                  className="rounded-lg border border-white/10 px-2.5 py-1 text-[11px] text-neutral-300">المبلغ كامل</button>
                <button type="button" onClick={() => setCashPaid('0')}
                  className="rounded-lg border border-white/10 px-2.5 py-1 text-[11px] text-neutral-300">كل المبلغ كريدي</button>
              </div>
              <p className="flex justify-between text-sm">
                <span className="text-neutral-400">المتبقي كريدي</span>
                <span className={creditRemainder > 0 ? 'text-red-300' : 'text-emerald-300'}>{formatDzd(creditRemainder)}</span>
              </p>
              {creditRemainder > 0 && (
                <p className="rounded border border-amber-700/30 bg-amber-950/20 p-2 text-[11px] leading-5 text-amber-200">
                  الباقي {formatDzd(creditRemainder)} سيُسجَّل ديناً على الزبون أو شيكاً عند تأكيد البيع.
                </p>
              )}
            </div>
            {error && <p className="mb-2 text-xs text-red-300">{error}</p>}
            <button
              type="button"
              disabled={saving}
              onClick={() => requestSale()}
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
