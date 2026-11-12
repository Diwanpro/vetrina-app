'use client'

import { useEffect, useMemo, useState } from 'react'
import Sheet from './Sheet'
import { formatMoney } from '@/lib/storefront'
import { safeVideoUrl, videoPlatform } from '@/lib/video'

const chipClass = 'min-h-10 rounded-xl border px-3 text-xs transition'
const activeClass = 'border-gold bg-gold/15 font-medium text-gold'
const idleClass = 'border-white/10 bg-white/5 text-neutral-300'

const soldOutClass = 'cursor-not-allowed border-white/5 bg-white/[0.02] text-neutral-500 opacity-50'

/**
 * A full look: the hero image or video, every piece with its own size/colour
 * choice, and — when the shop set one — the whole-outfit price.
 *
 * Each piece keeps its own selection because a look can mix sizes; the bundle
 * button refuses until every piece that has variants has one chosen, so the
 * customer never buys a look whose price was computed for stock that is gone.
 */
export default function LookSheet({ look, open, onClose, onAdd, onAddLook, showPrices, orderingEnabled = true }) {
  const [picked, setPicked] = useState({})
  const [added, setAdded] = useState(false)

  const items = look?.items || []
  const videoHref = safeVideoUrl(look?.video_url)
  const isDirectVideo = videoHref && videoPlatform(videoHref).key === 'other'

  // Start on the first buyable variant of each piece, the same way the product
  // sheet does, so the bundle button is usable without scrolling each row.
  useEffect(() => {
    if (!open || !look) return
    const next = {}
    for (const item of look.items || []) {
      const first = (item.variants || []).find(variant => Number(variant.available) > 0)
      if (first) next[item.product_id] = first.id
    }
    setPicked(next)
    setAdded(false)
  }, [open, look])

  const chosen = useMemo(() => items.map(item => {
    const variants = item.variants || []
    const variant = variants.find(entry => entry.id === picked[item.product_id]) || null
    return { item, variant, variants }
  }), [items, picked])

  const missing = chosen.filter(row => row.variants.length > 0 && !row.variant)
  const sum = chosen.reduce((total, row) => total + Number(row.item.base_price || 0), 0)
  const bundle = Number(look?.bundle_price || 0)

  // create_order() applies one offer per product, so a product already
  // discounted online keeps its own price and the outfit price cannot stack.
  // Showing the bundle button in that case would promise a total the order
  // will not charge, so it is hidden with the reason instead.
  const blocked = chosen.filter(row => row.item.has_offer).map(row => row.item.name)
  const hasBundle = bundle > 0 && items.length > 1 && blocked.length === 0
  const saving = hasBundle && sum > bundle ? sum - bundle : 0

  function buyBundle() {
    if (!orderingEnabled || missing.length) return
    // One call, not one per piece: the cart stores the look next to its lines so
    // the order carries a single look id that create_order can verify.
    const lines = chosen
      .filter(row => row.variants.length > 0 && row.variant)
      .map(row => ({ product: row.item, variant: row.variant }))
    onAddLook(look, lines)
    setAdded(true)
  }

  function buyOne(row) {
    if (!orderingEnabled || !row.variant) return
    onAdd({ product_id: row.item.product_id, name: row.item.name, image_url: row.item.image_url, base_price: row.item.base_price }, row.variant, 1)
  }

  return <Sheet open={open} onClose={onClose} labelledBy="look-title" full>
    <div className="sf-rail flex-1 overflow-y-auto pb-6">
      <header className="relative">
        {look?.image_url && <img src={look.image_url} alt="" className="h-64 w-full object-cover" />}
        <div aria-hidden="true" className="absolute inset-x-0 bottom-0 h-24 bg-gradient-to-t from-[#151515] to-transparent" />
        <button type="button" onClick={onClose} aria-label="إغلاق"
          className="absolute end-3 top-3 flex h-10 w-10 items-center justify-center rounded-full border border-white/15 bg-black/50 text-neutral-100 backdrop-blur">
          ✕
        </button>
      </header>

      <div className="px-4">
        <h2 id="look-title" className="mt-3 text-xl font-bold text-neutral-50">{look?.name}</h2>
        {look?.description && <p className="mt-1 text-sm leading-relaxed text-neutral-400">{look.description}</p>}

        {videoHref && (
          <div className="mt-3">
            {isDirectVideo
              ? <video src={videoHref} controls playsInline className="w-full rounded-2xl border border-white/10" />
              : <a href={videoHref} target="_blank" rel="noreferrer"
                  className="flex min-h-11 items-center justify-center rounded-xl border border-gold/30 bg-gold/10 text-sm text-gold">
                  شاهد فيديو الإطلالة
                </a>}
          </div>
        )}

        <h3 className="mt-5 text-sm text-neutral-300">قطع الإطلالة · {items.length}</h3>
        <ul className="mt-2 space-y-3">
          {chosen.map(row => {
            const variants = row.variants
            const sizes = [...new Set(variants.map(variant => variant.size || ''))]
            const colors = [...new Set(variants.map(variant => variant.color || ''))]
            const soldOut = variants.length === 0
            return <li key={row.item.product_id} className="rounded-2xl border border-white/8 bg-white/[0.02] p-3">
              <div className="flex items-start gap-3">
                {row.item.image_url && <img src={row.item.image_url} alt="" className="h-16 w-16 shrink-0 rounded-xl object-cover" />}
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm text-neutral-100">{row.item.name}</p>
                  {showPrices && <p className="mt-0.5 text-sm font-bold text-gold">{formatMoney(row.item.base_price)}</p>}
                  {soldOut && <p className="mt-1 text-[11px] text-neutral-500">غير متوفر في هذا المتجر</p>}
                </div>
                <button type="button" disabled={soldOut || !row.variant || !orderingEnabled}
                  onClick={() => buyOne(row)}
                  className="shrink-0 rounded-xl border border-gold/40 bg-gold/10 px-3 py-2 text-xs text-gold disabled:opacity-40">
                  أضف
                </button>
              </div>

              {!soldOut && (sizes.length > 1 || colors.length > 1) && (
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {colors.length > 1 && colors.map(color => {
                    const usable = variants.some(variant => (variant.color || '') === color && Number(variant.available) > 0)
                    const active = (row.variant?.color || '') === color
                    return <button key={`c-${color}`} type="button" disabled={!usable}
                      onClick={() => {
                        const next = variants.find(variant => (variant.color || '') === color && Number(variant.available) > 0)
                        if (next) setPicked(previous => ({ ...previous, [row.item.product_id]: next.id }))
                      }}
                      className={`${chipClass} ${active ? activeClass : usable ? idleClass : soldOutClass}`}>
                      {color || 'أساسي'}
                    </button>
                  })}
                  {sizes.length > 1 && sizes.map(size => {
                    const usable = variants.some(variant => (variant.size || '') === size && Number(variant.available) > 0)
                    const active = (row.variant?.size || '') === size
                    return <button key={`s-${size}`} type="button" disabled={!usable}
                      onClick={() => {
                        const next = variants.find(variant => (variant.size || '') === size && Number(variant.available) > 0)
                        if (next) setPicked(previous => ({ ...previous, [row.item.product_id]: next.id }))
                      }}
                      className={`${chipClass} ${active ? activeClass : usable ? idleClass : soldOutClass}`}>
                      {size || 'مقاس'}
                    </button>
                  })}
                </div>
              )}
            </li>
          })}
        </ul>

        {showPrices && <div className="mt-4 rounded-2xl border border-gold/20 bg-black/25 p-4">
          <p className="text-xs text-neutral-500">
            منفصلة: <span className="text-neutral-300">{formatMoney(sum)}</span>
          </p>
          {hasBundle && <p className="mt-1 text-sm text-neutral-200">
            الإطلالة كاملة: <span className="text-lg font-bold text-gold">{formatMoney(bundle)}</span>
            {saving > 0 && <span className="text-emerald-300"> · توفير {formatMoney(saving)}</span>}
          </p>}
          {hasBundle && saving <= 0 && <p className="mt-1 text-[11px] text-neutral-500">
            سعر الإطلالة غير أقل من مجموع القطع.
          </p>}
        </div>}

        {blocked.length > 0 && bundle > 0 && (
          <p className="mt-3 rounded-xl border border-amber-700/30 bg-amber-950/20 p-3 text-[11px] leading-5 text-amber-200">
            بعض القطع عليها عرض خاص، ويُباع كل منتج بعرض واحد فقط، لذا يُحسب سعرها بسعرها المعروض.
            أزل العرض من شاشة العروض لتفعيل سعر الإطلالة كاملة: {blocked.join(' · ')}
          </p>
        )}

        {orderingEnabled ? (
          hasBundle
            ? <button type="button" onClick={buyBundle} disabled={Boolean(missing.length) || added}
                className="mt-3 mb-2 flex min-h-14 w-full items-center justify-center rounded-2xl bg-gold px-4 text-sm font-bold text-[#121212] disabled:opacity-40">
                {added ? 'أُضيفت إلى السلة ✓'
                  : missing.length ? `اختر المقاس لـ ${missing.length} قطعة`
                    : `اشترِ الإطلالة كاملة بـ ${formatMoney(bundle)}`}
              </button>
            : <p className="mt-3 mb-2 rounded-xl border border-white/10 bg-white/[0.02] p-3 text-center text-xs text-neutral-400">
                هذا الإطلالة تُباع قطعةً قطعة.
              </p>
        ) : (
          <p className="mt-3 mb-2 rounded-xl border border-white/10 p-3 text-center text-xs text-neutral-400">
            الطلبات متوقفة مؤقتاً.
          </p>
        )}
      </div>
    </div>
  </Sheet>
}
