'use client'

import { useState } from 'react'

// The same sf-card, sf-hero-title and gold tokens as the current branch's
// theme: ivory/rose in the feminine shop, navy/bronze in the masculine shop.
function Destination({ item, className, children }) {
  return item.href
    ? <a href={item.href} rel="noreferrer" aria-label={item.title} className={`${className} focus-visible:outline-gold`}>{children}</a>
    : <div className={className}>{children}</div>
}

export function StoreBanners({ items, onImageError }) {
  const [selected, setSelected] = useState(null)
  const index = Math.max(0, items.findIndex(item => item.id === selected))
  const item = items[index]
  const step = delta => setSelected(items[(index + delta + items.length) % items.length].id)
  return <section aria-label="بانرات المتجر" className="pb-3 pt-5">
    <div className="sf-card overflow-hidden rounded-3xl border border-gold/20 bg-card">
      <Destination item={item} className="grid items-center sm:grid-cols-[minmax(0,1.75fr)_minmax(0,1fr)]">
        <img src={item.imageUrl} alt="" referrerPolicy="no-referrer" onError={() => onImageError(item.imageUrl)}
          className="aspect-[5/2] w-full rounded-2xl object-cover" />
        <div className="min-w-0 space-y-2 p-4 sm:p-6" aria-live="polite">
          <p className="sf-hero-kicker flex items-center gap-2 text-xs font-medium text-gold"><span aria-hidden="true" className="h-px w-6 bg-gold" />مختارات المتجر</p>
          <h2 className="sf-hero-title break-words text-2xl font-bold leading-tight text-foreground">{item.title}</h2>
          {item.href && <span className="inline-flex items-center gap-1 text-xs font-bold text-gold">اكتشف المزيد <span aria-hidden="true">←</span></span>}
        </div>
      </Destination>
      {items.length > 1 && <div className="flex items-center justify-end gap-2 border-t border-gold/20 px-4 py-1 text-sm text-gold">
        <button type="button" aria-label="البانر السابق" onClick={() => step(-1)} className="min-h-11 min-w-11 rounded-xl hover:bg-gold/10">→</button>
        <bdi dir="ltr" className="text-xs tabular-nums">{index + 1} / {items.length}</bdi>
        <button type="button" aria-label="البانر التالي" onClick={() => step(1)} className="min-h-11 min-w-11 rounded-xl hover:bg-gold/10">←</button>
      </div>}
    </div>
  </section>
}

export function EditorialSections({ items, onImageError }) {
  return <section aria-labelledby="editorial-heading" className="py-3">
    <h2 id="editorial-heading" className="mb-3 flex items-center gap-2 text-lg font-bold text-foreground"><span aria-hidden="true" className="h-px w-6 bg-gold" />اكتشف الأقسام</h2>
    <ul tabIndex={0} aria-labelledby="editorial-heading" className="flex snap-x gap-3 overflow-x-auto pb-3 focus-visible:outline-gold">
      {items.map(item => <li key={item.id} className="sf-card w-40 shrink-0 snap-start overflow-hidden rounded-2xl border border-gold/20 bg-card sm:w-52">
        <Destination item={item} className="block h-full">
          <img src={item.imageUrl} alt="" loading="lazy" referrerPolicy="no-referrer" onError={() => onImageError(item.imageUrl)}
            className="aspect-[3/2] w-full rounded-xl object-cover" />
          <div className="sf-card-body flex items-center justify-between gap-2 p-3"><h3 className="sf-card-title break-words text-sm font-bold text-foreground">{item.title}</h3>
            {item.href && <span aria-hidden="true" className="shrink-0 text-gold">←</span>}
          </div>
        </Destination>
      </li>)}
    </ul>
  </section>
}
