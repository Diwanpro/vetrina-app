'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { supabase } from '@/lib/supabase'
import {
  normalizeProducts, categoriesOf, priceCart, cartCount, cartTotal, formatMoney,
} from '@/lib/storefront'
import StoreHeader, { StoreHero } from './StoreHeader'
import ProductSheet from './ProductSheet'
import CartSheet from './CartSheet'
import OrderSuccess from './OrderSuccess'

function ProductCard({ product, showPrices, index, onOpen, onQuickAdd }) {
  const single = product.variants.length === 1 ? product.variants[0] : null
  return (
    <article
      className="sf-fade-up group overflow-hidden rounded-2xl border border-white/10 bg-white/[0.03]"
      style={{ animationDelay: `${Math.min(index, 8) * 45}ms` }}
    >
      <button type="button" onClick={onOpen} className="block w-full text-start">
        <div className="relative aspect-[3/4] overflow-hidden bg-[#0d0d0d]">
          {product.image_url
            ? <img src={product.image_url} alt={product.name} loading="lazy" className="h-full w-full object-cover transition duration-500 group-active:scale-105" />
            : <div className="flex h-full items-center justify-center text-3xl text-white/10">▦</div>}
          <div aria-hidden="true" className="absolute inset-x-0 bottom-0 h-16 bg-gradient-to-t from-black/70 to-transparent" />
          {product.offers?.length > 0 && (
            <span className="absolute start-2 top-2 rounded-full border border-gold/40 bg-black/60 px-2 py-0.5 text-[10px] text-gold backdrop-blur">
              {product.offers[0].kind === 'percent'
                ? `−${product.offers[0].discount_percentage}%`
                : `${product.offers[0].required_qty} بـ${product.offers[0].offer_price}`}
            </span>
          )}
        </div>
      </button>

      <div className="p-3">
        <p className="line-clamp-2 min-h-[2.5rem] text-[13px] font-medium leading-snug text-neutral-100">{product.name}</p>
        <div className="mt-2 flex items-center justify-between gap-2">
          <span className="text-sm font-bold text-gold">
            {showPrices ? formatMoney(product.base_price) : 'اسأل عن السعر'}
          </span>
          <button
            type="button"
            aria-label={`أضف ${product.name} إلى السلة`}
            onClick={() => (single ? onQuickAdd(product, single) : onOpen())}
            className="flex h-9 w-9 items-center justify-center rounded-xl bg-gold text-lg font-bold text-[#121212] shadow-[0_4px_14px_rgba(212,175,55,0.3)] active:scale-90"
          >
            +
          </button>
        </div>
      </div>
    </article>
  )
}

function MissingStore() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center px-6 text-center">
      <div className="sf-fade-up relative">
        <div aria-hidden="true" className="sf-halo absolute inset-0 -z-10 rounded-full bg-gold/10 blur-3xl" />
        <p className="text-6xl font-black tracking-tight text-gold/80">404</p>
        <h1 className="mt-4 text-xl font-bold text-neutral-100">هذا المتجر غير موجود</h1>
        <p className="mx-auto mt-2 max-w-[32ch] text-sm leading-relaxed text-neutral-400">
          قد يكون الرابط قديماً أو أن المتجر غير مفعّل حالياً. تأكد من الرابط أو تواصل مع صاحب المتجر.
        </p>
        <a
          href="/"
          className="mt-6 inline-flex min-h-12 items-center justify-center rounded-2xl border border-gold/30 bg-gold/10 px-6 text-sm font-medium text-gold"
        >
          العودة للرئيسية
        </a>
      </div>
    </main>
  )
}

export default function Storefront({ slug }) {
  const [status, setStatus] = useState('loading')
  const [store, setStore] = useState(null)
  const [products, setProducts] = useState([])
  const [category, setCategory] = useState('all')
  const [selected, setSelected] = useState(null)
  const [cart, setCart] = useState([])
  const [cartOpen, setCartOpen] = useState(false)
  const [success, setSuccess] = useState(null)
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    setStatus('loading')
    setError('')
    try {
      const { data: storeData, error: storeError } = await supabase.rpc('get_store_by_slug', { p_slug: slug })
      if (storeError) throw storeError
      if (!storeData) { setStatus('missing'); return }
      setStore(storeData)

      const { data: list, error: productsError } = await supabase.rpc('get_store_products', { p_store_id: storeData.store_id })
      if (productsError) throw productsError
      setProducts(normalizeProducts(list))
      setStatus('ready')
    } catch (err) {
      setError(err.message || 'تعذر تحميل المتجر')
      setStatus('error')
    }
  }, [slug])

  useEffect(() => { load() }, [load])

  const categories = useMemo(() => categoriesOf(products), [products])
  const visible = useMemo(
    () => (category === 'all' ? products : products.filter(product => product.category === category)),
    [products, category]
  )
  const offers = useMemo(() => products.flatMap(product => product.offers), [products])
  const priced = useMemo(() => priceCart(cart, offers), [cart, offers])
  const count = cartCount(cart)
  const total = cartTotal(priced)
  const showPrices = store?.show_prices !== false
  const orderingEnabled = store?.accepts_orders !== false

  function addToCart(product, variant, qty = 1) {
    setCart(previous => {
      const existing = previous.find(item => item.variantId === variant.id)
      if (existing) {
        return previous.map(item => item.variantId === variant.id
          ? { ...item, qty: Math.min(item.qty + qty, item.max) }
          : item)
      }
      return [...previous, {
        variantId: variant.id,
        productId: product.id,
        productName: product.name,
        size: variant.size || '',
        color: variant.color || '',
        unitPrice: Number(product.base_price || 0),
        image: product.image_url || '',
        max: Number(variant.available || 0),
        qty: Math.min(qty, Number(variant.available || 0)),
      }]
    })
  }

  function changeQty(variantId, delta) {
    setCart(previous => previous
      .map(item => item.variantId === variantId
        ? { ...item, qty: Math.max(1, Math.min(item.qty + delta, item.max)) }
        : item))
  }

  function removeLine(variantId) {
    setCart(previous => previous.filter(item => item.variantId !== variantId))
  }

  if (status === 'missing') return <MissingStore />

  if (status === 'error') {
    return (
      <main className="flex min-h-screen flex-col items-center justify-center px-6 text-center">
        <p className="text-lg font-bold text-neutral-100">تعذر فتح المتجر</p>
        <p className="mt-2 max-w-[34ch] text-sm text-neutral-400">{error}</p>
        <button type="button" onClick={load} className="mt-6 min-h-12 rounded-2xl bg-gold px-6 text-sm font-bold text-[#121212]">
          إعادة المحاولة
        </button>
      </main>
    )
  }

  return (
    <div className="relative min-h-screen pb-28">
      {store && <StoreHeader store={store} cartCount={count} onCart={() => setCartOpen(true)} />}

      {status === 'loading' || !store ? (
        <main className="mx-auto max-w-lg px-4 pt-6">
          <div className="sf-skeleton h-32 rounded-3xl" />
          <div className="mt-4 grid grid-cols-2 gap-3">
            {Array.from({ length: 6 }).map((_, index) => <div key={index} className="sf-skeleton aspect-[3/4] rounded-2xl" />)}
          </div>
        </main>
      ) : (
        <main className="mx-auto max-w-lg">
          <StoreHero store={store} />

          {categories.length > 0 && (
            <nav aria-label="الأقسام" className="sf-rail mt-4 flex gap-2 overflow-x-auto px-4 pb-1">
              <button
                type="button"
                onClick={() => setCategory('all')}
                className={`min-h-10 shrink-0 rounded-full border px-4 text-sm transition ${
                  category === 'all' ? 'border-gold bg-gold/15 font-medium text-gold' : 'border-white/10 bg-white/5 text-neutral-300'
                }`}
              >
                الكل
              </button>
              {categories.map(value => (
                <button
                  key={value}
                  type="button"
                  onClick={() => setCategory(value)}
                  className={`min-h-10 shrink-0 rounded-full border px-4 text-sm transition ${
                    category === value ? 'border-gold bg-gold/15 font-medium text-gold' : 'border-white/10 bg-white/5 text-neutral-300'
                  }`}
                >
                  {value}
                </button>
              ))}
            </nav>
          )}

          {!visible.length ? (
            <div className="mx-auto mt-16 max-w-xs text-center">
              <p className="text-4xl">🧺</p>
              <p className="mt-3 text-neutral-300">لا توجد منتجات متوفرة حالياً</p>
              <p className="mt-1 text-sm text-neutral-500">عد قريباً، نضيف قطعاً جديدة باستمرار.</p>
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-3 px-4 py-4">
              {visible.map((product, index) => (
                <ProductCard
                  key={product.id}
                  product={product}
                  index={index}
                  showPrices={showPrices}
                  onOpen={() => setSelected(product)}
                  onQuickAdd={addToCart}
                />
              ))}
            </div>
          )}

          <p className="px-4 pb-6 pt-2 text-center text-[11px] text-neutral-600">
            {store.name} · {store.accepts_orders === false ? 'الطلبات متوقفة مؤقتاً' : 'الدفع عند الاستلام'}
          </p>
        </main>
      )}

      {/* Floating cart: always reachable by thumb, never covers the last card. */}
      {count > 0 && orderingEnabled && !cartOpen && !success && (
        <div className="fixed inset-x-0 bottom-0 z-40 px-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
          <button
            type="button"
            onClick={() => setCartOpen(true)}
            className="sf-fade-up mx-auto flex min-h-14 w-full max-w-lg items-center justify-between gap-3 rounded-2xl border border-gold/30 bg-[#1a1a1a]/90 px-4 shadow-[0_16px_40px_rgba(0,0,0,0.55)] backdrop-blur-xl active:scale-[0.99]"
          >
            <span className="flex items-center gap-2 text-sm font-medium text-neutral-100">
              <span className="flex h-8 w-8 items-center justify-center rounded-full bg-gold text-xs font-bold text-[#121212]">{count}</span>
              عرض السلة
            </span>
            <span className="text-sm font-bold text-gold">{showPrices ? formatMoney(total) : 'متابعة'}</span>
          </button>
        </div>
      )}

      <ProductSheet
        product={selected}
        open={Boolean(selected)}
        onClose={() => setSelected(null)}
        onAdd={addToCart}
        showPrices={showPrices}
        orderingEnabled={orderingEnabled}
      />

      {store && (
        <CartSheet
          open={cartOpen}
          onClose={() => setCartOpen(false)}
          store={store}
          cart={cart}
          priced={priced}
          showPrices={showPrices}
          onQty={changeQty}
          onRemove={removeLine}
          onConfirmed={result => {
            setCartOpen(false)
            setCart([])
            setSuccess(result)
          }}
        />
      )}

      {success && (
        <OrderSuccess
          slug={slug}
          token={success.token}
          orderNumber={success.orderNumber}
          total={success.total}
          showPrices={showPrices}
          onContinue={() => setSuccess(null)}
        />
      )}
    </div>
  )
}
