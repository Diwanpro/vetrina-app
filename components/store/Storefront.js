'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import LookSheet from './LookSheet'
import useStoreLooks from './useStoreLooks'
import { supabase } from '@/lib/supabase'
import {
  normalizeProducts, categoriesOf, priceCart, cartCount, cartTotal, formatMoney,
  offerBadge, isSoldOut, whatsappLink, lookUnitPrices, productImage,
  productsForTab, offersOf,
} from '@/lib/storefront'
import { safeVideoUrl, videoButtonLabel } from '@/lib/video'
import StoreHeader, { StoreHero } from './StoreHeader'
import ProductSheet from './ProductSheet'
import CartSheet from './CartSheet'
import OrderSuccess from './OrderSuccess'
import StoreTabRail, { buildStoreTabs } from './StoreTabRail'
import ProductImage from './ProductImage'

function ProductCard({ product, store, showPrices, index, onOpen, onQuickAdd }) {
  const single = product.variants.length === 1 ? product.variants[0] : null
  const badge = offerBadge(product.offers?.[0])
  const soldOut = isSoldOut(product)
  const askLink = whatsappLink(store?.phone, `مرحباً ${store?.name || ''}، أريد معرفة سعر: ${product.name}`)
  // Only an http(s) link is ever rendered; the column can hold anything.
  const videoHref = safeVideoUrl(product.external_video_url)
  const videoLabel = videoButtonLabel(videoHref)

  return (
    <article
      className="sf-fade-up group overflow-hidden rounded-2xl border border-white/10 bg-white/[0.03]"
      style={{ animationDelay: `${Math.min(index, 8) * 45}ms` }}
    >
      <div className="relative aspect-[3/4] overflow-hidden bg-[#0d0d0d]">
        {/* The same element the POS uses: productImage() picks the source, and a
            URL that 404s now draws a labelled placeholder instead of an empty
            square, so a bad link is visible here rather than only in the logs. */}
        <ProductImage product={product} alt={product.name} label="بدون صورة"
          className="h-full w-full object-cover transition duration-500 group-active:scale-105" />
        <div aria-hidden="true" className="absolute inset-x-0 bottom-0 h-16 bg-gradient-to-t from-black/70 to-transparent" />
        {/* The whole picture opens the product, but the video link sits above it
            so tapping the badge plays the video instead of the modal. */}
        <button
          type="button"
          onClick={onOpen}
          aria-label={`عرض ${product.name}`}
          className="absolute inset-0 h-full w-full"
        />
        {badge && (
          <span className="pointer-events-none absolute start-2 top-2 z-10 flex items-center gap-1 rounded-full border border-gold/50 bg-gradient-to-l from-[#E8C55A] to-[#C9A227] px-2.5 py-1 text-[10px] font-bold text-[#121212] shadow-[0_6px_18px_rgba(212,175,55,0.35)]">
            <span aria-hidden="true">✦</span>
            {badge}
          </span>
        )}
        {soldOut && (
          <span className="pointer-events-none absolute inset-x-2 bottom-2 z-10 rounded-lg bg-black/70 py-1 text-center text-[11px] text-neutral-200 backdrop-blur">
            نفدت الكمية
          </span>
        )}
        {videoHref && (
          <a
            href={videoHref}
            target="_blank"
            rel="noopener noreferrer"
            aria-label={videoLabel}
            className="absolute end-2 top-2 z-20 flex items-center gap-1 rounded-full border border-white/25 bg-black/65 py-1 pe-2.5 ps-1.5 text-[10px] font-medium text-neutral-50 shadow-lg backdrop-blur transition active:scale-95"
          >
            <span aria-hidden="true" className="flex h-5 w-5 items-center justify-center rounded-full bg-gold text-[9px] text-[#121212]">▶</span>
            فيديو
          </a>
        )}
      </div>

      <div className="p-3">
        <p className="line-clamp-2 min-h-[2.5rem] text-[13px] font-medium leading-snug text-neutral-100">{product.name}</p>
        <div className="mt-2 flex items-center justify-between gap-2">
          {showPrices ? (
            <span className="text-sm font-bold text-gold">{formatMoney(product.base_price)}</span>
          ) : (
            <a
              href={askLink}
              target="_blank"
              rel="noopener noreferrer"
              className="text-[11px] font-medium text-gold underline decoration-gold/30 underline-offset-4"
            >
              اسأل عن السعر
            </a>
          )}
          <button
            type="button"
            aria-label={`أضف ${product.name} إلى السلة`}
            disabled={soldOut}
            onClick={() => (single && single.available > 0 ? onQuickAdd(product, single) : onOpen())}
            className="flex min-h-9 items-center gap-1 rounded-xl bg-gold px-3 text-[11px] font-bold text-[#121212] shadow-[0_4px_14px_rgba(212,175,55,0.3)] transition active:scale-95 disabled:opacity-30"
          >
            <span aria-hidden="true" className="text-sm leading-none">+</span>
            أضف
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

/**
 * The storefront's tab rail.
 *
 * The chips and the rail itself now come from components/store/StoreTabRail,
 * which the POS also renders — so "the same tab bar" is one component, not two
 * copies that have to be kept in step by hand.
 */
function StoreTabs({ tab, onTab, categories, offerCount, lookCount, loadingLooks }) {
  const chips = buildStoreTabs({ categories, offerCount, lookCount, loadingLooks })
  return <StoreTabRail chips={chips} active={tab} onSelect={onTab} ariaLabel="أقسام المتجر" />
}

/** Large, full-bleed outfit cards — the tab is a lookbook, not a grid. */
function LooksGrid({ looks, loading, showPrices, onOpen }) {
  if (loading) {
    return (
      <div className="mt-4 space-y-4 px-4 pb-4">
        {Array.from({ length: 2 }).map((_, index) => <div key={index} className="sf-skeleton h-72 rounded-3xl" />)}
      </div>
    )
  }
  if (!looks.length) {
    return (
      <div className="mx-auto mt-16 max-w-xs px-4 text-center">
        <p className="text-4xl">✨</p>
        <p className="mt-3 text-neutral-300">لا توجد إطلالات حالياً</p>
        <p className="mt-1 text-sm text-neutral-500">عد قريباً، نجهّز إطلالات جديدة.</p>
      </div>
    )
  }
  return (
    <div className="mt-4 space-y-4 px-4 pb-4">
      {looks.map((look, index) => (
        <button
          key={look.id}
          type="button"
          onClick={() => onOpen(look)}
          className="sf-fade-up group block w-full overflow-hidden rounded-3xl border border-white/10 bg-[#161616] text-start shadow-[0_18px_44px_rgba(0,0,0,0.45)]"
          style={{ animationDelay: `${Math.min(index, 6) * 60}ms` }}
        >
          <div className="relative">
            {/* No ternary needed any more: ProductImage draws the same labelled
                placeholder whether the look has no cover or the cover 404s. */}
            <ProductImage product={look} alt={look.name || ''}
              placeholderClassName="aspect-[4/5]"
              className="aspect-[4/5] w-full object-cover transition duration-500 group-active:scale-[1.02]" />
            <div aria-hidden="true" className="absolute inset-x-0 bottom-0 h-2/3 bg-gradient-to-t from-black/90 via-black/35 to-transparent" />
            <span className="absolute start-3 top-3 rounded-full border border-gold/45 bg-black/55 px-2.5 py-1 text-[10px] font-medium tracking-[0.18em] text-gold backdrop-blur">
              إطلالة
            </span>
            <div className="absolute inset-x-0 bottom-0 p-4">
              <h3 className="text-xl font-bold leading-snug text-white">{look.name}</h3>
              {look.description && (
                <p className="mt-1 line-clamp-2 text-[12px] leading-relaxed text-neutral-300">{look.description}</p>
              )}
              <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1">
                {showPrices && look.bundle_price != null && Number(look.bundle_price) > 0 && (
                  <p className="text-sm font-bold text-gold">{formatMoney(look.bundle_price)}</p>
                )}
                <p className="text-[11px] text-neutral-300">{(look.items || []).length} قطع · اضغط للتفاصيل</p>
              </div>
            </div>
          </div>
        </button>
      ))}
    </div>
  )
}

/**
 * What a tab says when it has nothing. A category that is simply empty and a
 * filter that matched nothing are different disappointments, and telling the
 * shopper "no products at all" in an offers tab reads like the shop is closed.
 */
function EmptyTab({ tab, hasOffers }) {
  if (tab === 'offers') {
    return (
      <div className="mx-auto mt-16 max-w-xs px-4 text-center">
        <p className="text-4xl">🏷️</p>
        <p className="mt-3 text-neutral-300">لا توجد عروض حالياً</p>
        <p className="mt-1 text-sm text-neutral-500">
          {hasOffers ? 'العروض المتاحة نفدت كميتها. تابعنا قريباً.' : 'تابعنا، نضيف عروضاً جديدة باستمرار.'}
        </p>
      </div>
    )
  }
  return (
    <div className="mx-auto mt-16 max-w-xs px-4 text-center">
      <p className="text-4xl">🧺</p>
      <p className="mt-3 text-neutral-300">لا توجد منتجات في هذا القسم</p>
      <p className="mt-1 text-sm text-neutral-500">جرّب قسماً آخر، أو تصفّح «الكل».</p>
    </div>
  )
}

export default function Storefront({ slug }) {
  const [status, setStatus] = useState('loading')
  const [store, setStore] = useState(null)
  const [products, setProducts] = useState([])
  // One selected tab: 'all', 'offers', 'looks', or a category name. A single
  // value instead of two flags, because the three are mutually exclusive and
  // two booleans let the screen land in states that cannot be drawn.
  const [tab, setTab] = useState('all')
  const [activeLook, setActiveLook] = useState(null)
  // The look that priced the current cart, or null. Cleared as soon as the cart
  // stops being exactly that outfit, so a half-removed look is not charged the
  // outfit price.
  const [cartLook, setCartLook] = useState(null)
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

  const { looks, loading: looksLoading } = useStoreLooks(slug)
  // A look tab with nothing behind it is worse than no tab at all.
  const showLooks = looks.length > 0

  const categories = useMemo(() => categoriesOf(products), [products])
  const discounted = useMemo(() => offersOf(products), [products])
  // The grid for the selected tab. 'looks' is not a grid at all, so it is
  // handled separately below; productsForTab() covers the rest.
  const visible = useMemo(() => productsForTab(products, tab), [products, tab])
  const offers = useMemo(() => products.flatMap(product => product.offers), [products])
  // Pieces from a look are already priced by the outfit; running them through
  // the offer engine again would apply a second discount on top.
  const priced = useMemo(() => priceCart(cart.map(item =>
    item.fromLook ? { ...item, manualPrice: true } : item), offers), [cart, offers])
  const count = cartCount(cart)
  const total = cartTotal(priced)
  const showPrices = store?.show_prices !== false
  const orderingEnabled = store?.accepts_orders !== false

  // `override` is the outfit's unit price for this piece. It is only a display
  // figure here: create_order recomputes it from the look, so a tampered value
  // in the browser cannot buy an outfit cheaply.
  function addToCart(product, variant, qty = 1, override = null) {
    if (!variant || Number(variant.available) <= 0) return
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
        unitPrice: Number(override ?? product.base_price ?? 0),
        image: productImage(product),
        max: Number(variant.available || 0),
        qty: Math.min(qty, Number(variant.available || 0)),
        fromLook: override != null,
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
    setCart(previous => {
      const next = previous.filter(item => item.variantId !== variantId)
      if (cartLook && !next.some(item => item.fromLook)) setCartLook(null)
      return next
    })
  }

  // Buying the whole outfit: every piece carries the look's unit price and the
  // look id travels with the order so create_order can verify it.
  function addLook(look, lines) {
    const units = lookUnitPrices(look)
    setCart(previous => {
      const next = [...previous]
      for (const { product, variant } of lines) {
        if (!variant || Number(variant.available) <= 0) continue
        const unit = Number(units[product.product_id] || product.base_price || 0)
        const existing = next.find(item => item.variantId === variant.id)
        if (existing) {
          existing.qty = Math.min(existing.qty + 1, existing.max)
          existing.unitPrice = unit
          existing.fromLook = true
        } else {
          next.push({
            variantId: variant.id,
            productId: product.product_id,
            productName: product.name,
            size: variant.size || '',
            color: variant.color || '',
            unitPrice: unit,
            image: productImage(product),
            max: Number(variant.available || 0),
            qty: 1,
            fromLook: true,
          })
        }
      }
      return next
    })
    setCartLook(look)
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

          {/* One rail for everything: the two merchandising tabs, then the
              categories. Only tabs with something behind them are drawn, so a
              shop with no offers does not offer an empty عروض tab. */}
          <StoreTabs
            tab={tab}
            onTab={setTab}
            categories={categories}
            offerCount={discounted.length}
            lookCount={looks.length}
            loadingLooks={looksLoading}
          />

          {tab === 'looks' ? (
            <LooksGrid looks={looks} loading={looksLoading} showPrices={showPrices} onOpen={setActiveLook} />
          ) : (
          <>

          {!visible.length ? (
            <EmptyTab tab={tab} hasOffers={discounted.length > 0} />
          ) : (
            <div className="grid grid-cols-2 gap-3 px-4 py-4">
              {visible.map((product, index) => (
                <ProductCard
                  key={product.id}
                  product={product}
                  store={store}
                  index={index}
                  showPrices={showPrices}
                  onOpen={() => setSelected(product)}
                  onQuickAdd={addToCart}
                />
              ))}
            </div>
          )}

          </>
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

      <LookSheet
        look={activeLook}
        onAddLook={addLook}
        open={Boolean(activeLook)}
        onClose={() => setActiveLook(null)}
        showPrices={showPrices}
        orderingEnabled={orderingEnabled}
        onAdd={addToCart}
      />

      <ProductSheet
        product={selected}
        open={Boolean(selected)}
        onClose={() => setSelected(null)}
        onAdd={addToCart}
        showPrices={showPrices}
        orderingEnabled={orderingEnabled}
        store={store}
      />

      {store && (
        <CartSheet
          open={cartOpen}
          lookId={cartLook?.id || null}
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
