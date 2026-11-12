'use client'

import { useEffect, useMemo, useState } from 'react'
import Sheet from './Sheet'
import { formatMoney, offerBadge, stockHint, whatsappLink } from '@/lib/storefront'

function offerText(offer) {
  if (offer.kind === 'percent') return `خصم ${offer.discount_percentage}%`
  return `${offer.required_qty} بـ ${formatMoney(offer.offer_price)}`
}

// A sold-out chip stays readable but is clearly unusable: dimmed, blurred, and
// not clickable. The exact quantity is never printed unless it is about to run
// out, which is the only time the number helps the customer.
const soldOutClass = 'cursor-not-allowed border-white/5 bg-white/[0.02] text-neutral-500 opacity-50 blur-sm'
const chipClass = 'min-h-11 rounded-xl border px-4 text-sm transition'
const activeClass = 'border-gold bg-gold/15 font-medium text-gold'

/**
 * Product detail. Every stocked variant is listed, sold-out ones included, so
 * the size rail shows what the shop really sells instead of quietly hiding it.
 */
export default function ProductSheet({ product, open, onClose, onAdd, showPrices, orderingEnabled = true, store }) {
  const [color, setColor] = useState('')
  const [size, setSize] = useState('')
  const [qty, setQty] = useState(1)

  const variants = product?.variants || []
  const colors = useMemo(() => [...new Set(variants.map(variant => variant.color || ''))], [variants])

  const inStock = (entry, targetColor) => variants.some(variant =>
    (variant.color || '') === targetColor
    && (entry == null || (variant.size || '') === entry)
    && Number(variant.available) > 0)

  // Reset the picker whenever another product is opened: start on something the
  // customer can actually buy.
  useEffect(() => {
    if (!open || !product) return
    const first = (product.variants || []).find(variant => Number(variant.available) > 0)
      || product.variants?.[0]
    setColor(first?.color || '')
    setSize(first?.size || '')
    setQty(1)
  }, [open, product])

  const sizesForColor = useMemo(
    () => [...new Set(variants.filter(variant => (variant.color || '') === color).map(variant => variant.size || ''))],
    [variants, color]
  )

  const variant = variants.find(entry => (entry.color || '') === color && (entry.size || '') === size)
  const max = Number(variant?.available || 0)
  const price = product?.base_price
  const lowStock = stockHint(max)
  const askLink = whatsappLink(store?.phone, `مرحباً ${store?.name || ''}، أريد معرفة سعر: ${product?.name || ''}`)

  // Choosing another colour can invalidate the size; fall back to one in stock.
  useEffect(() => {
    if (!sizesForColor.length) return
    if (sizesForColor.includes(size) && max > 0) return
    const available = sizesForColor.find(entry => inStock(entry, color))
    setSize(available ?? sizesForColor[0])
  }, [sizesForColor, size, color, max])

  return (
    <Sheet open={open} onClose={onClose} labelledBy="product-title" full>
      {product && (
        <>
          <div className="relative mt-2 shrink-0">
            <div className="relative mx-4 aspect-[4/3] overflow-hidden rounded-2xl bg-[#0d0d0d]">
              {product.image_url
                ? <img src={product.image_url} alt={product.name} className="h-full w-full object-cover" />
                : <div className="flex h-full items-center justify-center text-4xl text-white/10">🖼️</div>}
              <div aria-hidden="true" className="absolute inset-0 bg-gradient-to-t from-black/60 via-transparent to-transparent" />
            </div>
            <button
              type="button"
              onClick={onClose}
              aria-label="إغلاق"
              className="absolute end-6 top-2 flex h-10 w-10 items-center justify-center rounded-full border border-white/15 bg-black/50 text-neutral-200 backdrop-blur"
            >
              ✕
            </button>
            {product.offers?.length > 0 && (
              <span className="absolute start-6 top-2 rounded-full border border-gold/40 bg-black/60 px-3 py-1 text-[11px] font-medium text-gold backdrop-blur">
                {offerText(product.offers[0])}
              </span>
            )}
          </div>

          <div className="sf-rail flex-1 overflow-y-auto px-5 pb-4 pt-4">
            <h2 id="product-title" className="text-xl font-bold text-neutral-50">{product.name}</h2>
            {showPrices ? (
              <p className="mt-1 text-lg font-bold text-gold">{formatMoney(price)}</p>
            ) : (
              <a
                href={askLink}
                target="_blank"
                rel="noopener noreferrer"
                className="mt-1 inline-block text-sm font-medium text-gold underline decoration-gold/30 underline-offset-4"
              >
                اسأل عن السعر
              </a>
            )}
            {product.description && (
              <p className="mt-3 whitespace-pre-line text-sm leading-relaxed text-neutral-400">{product.description}</p>
            )}

            {product.offers?.length > 0 && (
              <div className="mt-4 flex flex-wrap gap-2">
                {product.offers.map(offer => (
                  <span key={offer.id} className="rounded-full border border-gold/25 bg-gold/5 px-3 py-1.5 text-[11px] text-gold/90">
                    {offer.name || offerBadge(offer) || offerText(offer)}
                  </span>
                ))}
              </div>
            )}

            {colors.length > 1 && (
              <div className="mt-5">
                <p className="mb-2 text-xs text-neutral-400">اللون</p>
                <div className="flex flex-wrap gap-2">
                  {colors.map(value => {
                    const active = value === color
                    const sellable = inStock(null, value)
                    return (
                      <button
                        key={value || 'none'}
                        type="button"
                        disabled={!sellable}
                        aria-disabled={!sellable}
                        onClick={() => setColor(value)}
                        className={`${chipClass} ${
                          active && sellable ? activeClass : 'border-white/10 bg-white/5 text-neutral-300'
                        } ${sellable ? '' : soldOutClass}`}
                      >
                        {value || 'بدون لون'}
                      </button>
                    )
                  })}
                </div>
              </div>
            )}

            {sizesForColor.length > 0 && (
              <div className="mt-4">
                <p className="mb-2 text-xs text-neutral-400">المقاس</p>
                <div className="flex flex-wrap gap-2">
                  {sizesForColor.map(value => {
                    const active = value === size
                    const sellable = inStock(value, color)
                    const left = variants.find(entry =>
                      (entry.color || '') === color && (entry.size || '') === value)?.available
                    return (
                      <button
                        key={value || 'none'}
                        type="button"
                        disabled={!sellable}
                        aria-disabled={!sellable}
                        onClick={() => { setSize(value); setQty(1) }}
                        className={`${chipClass} min-w-12 ${
                          active && sellable ? activeClass : 'border-white/10 bg-white/5 text-neutral-300'
                        } ${sellable ? '' : soldOutClass}`}
                      >
                        {value || 'موحّد'}
                        {sellable && stockHint(left) && (
                          <span className="ms-1 text-[10px] font-normal text-emerald-300/80">{stockHint(left)}</span>
                        )}
                      </button>
                    )
                  })}
                </div>
              </div>
            )}

            <div className="mt-5 flex items-center justify-between rounded-2xl border border-white/10 bg-white/[0.03] p-3">
              <div>
                <p className="text-xs text-neutral-400">الكمية</p>
                <p className="mt-0.5 text-[11px] text-neutral-500">
                  {max <= 0 ? 'غير متوفر بهذا المقاس' : (lowStock || 'متوفر')}
                </p>
              </div>
              <div className="flex items-center gap-3">
                <button
                  type="button"
                  aria-label="إنقاص الكمية"
                  disabled={qty <= 1}
                  onClick={() => setQty(value => Math.max(1, value - 1))}
                  className="h-11 w-11 rounded-xl border border-white/10 bg-white/5 text-lg text-neutral-200 disabled:opacity-30"
                >
                  −
                </button>
                <span className="min-w-6 text-center text-base font-bold text-neutral-100">{qty}</span>
                <button
                  type="button"
                  aria-label="زيادة الكمية"
                  disabled={qty >= max}
                  onClick={() => setQty(value => Math.min(max, value + 1))}
                  className="h-11 w-11 rounded-xl border border-white/10 bg-white/5 text-lg text-neutral-200 disabled:opacity-30"
                >
                  +
                </button>
              </div>
            </div>
          </div>

          <div className="shrink-0 border-t border-white/10 bg-[#101010]/80 p-4 pb-[max(1rem,env(safe-area-inset-bottom))] backdrop-blur">
            <button
              type="button"
              disabled={!variant || !orderingEnabled}
              onClick={() => { onAdd(product, variant, qty); onClose() }}
              className="flex min-h-14 w-full items-center justify-center gap-2 rounded-2xl bg-gradient-to-l from-[#E8C55A] to-gold font-bold text-[#121212] shadow-[0_10px_30px_rgba(212,175,55,0.25)] transition active:scale-[0.98] disabled:opacity-40"
            >
              {!orderingEnabled
                ? 'الطلبات متوقفة مؤقتاً'
                : variant
                  ? <>أضف إلى السلة{showPrices ? ` · ${formatMoney((price || 0) * qty)}` : ''}</>
                  : 'اختر مقاساً متوفراً'}
            </button>
          </div>
        </>
      )}
    </Sheet>
  )
}
