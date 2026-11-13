'use client'

import { useEffect, useState } from 'react'
import { productImage } from '@/lib/storefront'

/**
 * The one place a product picture is drawn.
 *
 * Two rules, both learned the hard way:
 *
 *  1. The source is productImage(product), never `product.image_url`. That
 *     helper prefers a usable entry from images[] and falls back to image_url,
 *     and both the seed and the dashboard write into images[] — reading the
 *     single column directly is how the storefront and the POS ended up
 *     disagreeing about which products had a picture.
 *
 *  2. A URL that fails to load must be *visible*. A bare <img> that 404s
 *     collapses to nothing on a dark card, which is indistinguishable from a
 *     product that never had a photo, so the page looks broken and there is
 *     nothing to debug. Here a failed load swaps in a labelled placeholder and
 *     logs the URL once, so the console names the exact bad link.
 *
 * `label` is rendered inside the placeholder. The customer-facing pages pass
 * the Arabic "بدون صورة"; the POS can pass its debug variant.
 */
export default function ProductImage({
  product,
  alt = '',
  className = '',
  placeholderClassName = '',
  label = 'بدون صورة',
  eager = false,
}) {
  const src = productImage(product)

  // A different product (or a corrected URL) must retry, not stay broken.
  const [failed, setFailed] = useState(false)
  useEffect(() => { setFailed(false) }, [src])

  if (!src || failed) {
    return (
      <div
        className={`flex h-full w-full flex-col items-center justify-center gap-1 bg-[#1b1b1b] text-neutral-500 ${placeholderClassName}`}
        role="img"
        aria-label={alt || label}
      >
        <span aria-hidden="true" className="text-lg leading-none text-neutral-600">▦</span>
        <span className="px-1 text-center text-[10px] leading-tight">{label}</span>
      </div>
    )
  }

  return (
    <img
      src={src}
      alt={alt}
      loading={eager ? 'eager' : 'lazy'}
      className={className}
      onError={event => {
        // Keep the console honest: this is the only signal that a stored URL
        // is wrong rather than the product simply having no photo.
        console.warn('[product-image] failed to load, showing placeholder:', src)
        event.currentTarget.dataset.failedSrc = src
        setFailed(true)
      }}
    />
  )
}
