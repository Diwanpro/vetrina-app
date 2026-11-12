'use client'


function initials(name) {
  return (name || 'متجر').trim().slice(0, 2)
}

function mapsHref(store) {
  if (store.google_maps_url) return store.google_maps_url
  const query = [store.name, store.address].filter(Boolean).join(' ')
  return query ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}` : ''
}

/**
 * Sticky glass header. The call and map actions are deliberately large: this
 * is read on a phone, often with one hand.
 */
export default function StoreHeader({ store, cartCount = 0, onCart }) {
  const maps = mapsHref(store)

  return (
    <>
      <div aria-hidden="true" className="pointer-events-none absolute inset-x-0 top-0 h-64 overflow-hidden">
        <div className="sf-halo absolute -top-24 start-1/2 h-56 w-56 -translate-x-1/2 rounded-full bg-gold/25 blur-3xl" />
      </div>

      <header className="sticky top-0 z-30 border-b border-white/5 bg-[#121212]/80 backdrop-blur-xl">
        <div className="mx-auto flex max-w-lg items-center gap-3 px-4 py-3">
          <div className="flex h-12 w-12 shrink-0 items-center justify-center overflow-hidden rounded-2xl border border-gold/30 bg-gradient-to-br from-[#232014] to-[#141414] text-sm font-bold text-gold shadow-[0_0_24px_rgba(212,175,55,0.15)]">
            {store.logo_url
              // The owner uploads this; a broken link must not take the page down.
              ? <img src={store.logo_url} alt="" className="h-full w-full object-cover" onError={event => { event.currentTarget.style.display = 'none' }} />
              : <span>{initials(store.name)}</span>}
          </div>

          <div className="min-w-0 flex-1">
            <h1 className="truncate text-base font-bold text-neutral-50">{store.name}</h1>
            <p className="truncate text-[11px] text-neutral-400">
              {store.accepts_orders === false ? 'الطلبات متوقفة مؤقتاً' : 'متجر إلكتروني · دفع عند الاستلام'}
            </p>
          </div>

          <div className="flex shrink-0 items-center gap-2">
            {store.phone && (
              <a
                href={`tel:${store.phone.replace(/\s/g, '')}`}
                aria-label="اتصل بالمتجر"
                className="flex h-11 w-11 items-center justify-center rounded-2xl border border-white/10 bg-white/5 text-gold active:scale-95"
              >
                <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true">
                  <path d="M6.5 3.5h3l1.5 4-2 1.5a12 12 0 0 0 6 6l1.5-2 4 1.5v3a2 2 0 0 1-2.2 2A17 17 0 0 1 4.5 5.7 2 2 0 0 1 6.5 3.5Z" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </a>
            )}
            {maps && (
              <a
                href={maps}
                target="_blank"
                rel="noreferrer"
                aria-label="موقع المتجر على الخريطة"
                className="flex h-11 w-11 items-center justify-center rounded-2xl border border-white/10 bg-white/5 text-gold active:scale-95"
              >
                <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true">
                  <path d="M12 21s7-6.1 7-11a7 7 0 1 0-14 0c0 4.9 7 11 7 11Z" strokeLinejoin="round" />
                  <circle cx="12" cy="10" r="2.5" />
                </svg>
              </a>
            )}
            <button
              type="button"
              onClick={onCart}
              aria-label={`السلة، ${cartCount} قطعة`}
              className="relative flex h-11 w-11 items-center justify-center rounded-2xl border border-gold/40 bg-gold/10 text-gold active:scale-95"
            >
              <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true">
                <path d="M4 5h2l2.2 10.2a2 2 0 0 0 2 1.6h7.4a2 2 0 0 0 2-1.6L21 8H7" strokeLinecap="round" strokeLinejoin="round" />
                <circle cx="10" cy="20" r="1.3" /><circle cx="18" cy="20" r="1.3" />
              </svg>
              {cartCount > 0 && (
                <span className="sf-pop absolute -end-1 -top-1 min-w-[18px] rounded-full bg-gold px-1 text-center text-[10px] font-bold leading-[18px] text-[#121212]">
                  {cartCount}
                </span>
              )}
            </button>
          </div>
        </div>
      </header>
    </>
  )
}

export function StoreHero({ store }) {
  return (
    <section className="sf-fade-up px-4 pb-2 pt-5">
      <div className="relative overflow-hidden rounded-3xl border border-gold/20 bg-gradient-to-br from-[#1d1a12] via-[#161616] to-[#121212] p-5">
        <div aria-hidden="true" className="absolute -end-10 -top-10 h-32 w-32 rounded-full bg-gold/10 blur-2xl" />
        <p className="text-[11px] uppercase tracking-[0.2em] text-gold/70">اختيار أنيق</p>
        <h2 className="mt-2 text-2xl font-bold leading-snug text-neutral-50">
          تسوّق من {store.name}
        </h2>
        <p className="mt-2 max-w-[34ch] text-sm leading-relaxed text-neutral-400">
          {store.accepts_orders === false
            ? 'المتجر يعرض منتجاته حالياً، والطلبات ستُستأنف قريباً.'
            : 'اطلب من هاتفك، والدفع عند الاستلام. نجمع لك الطلب ونؤكده عبر الهاتف.'}
        </p>
        {store.address && (
          <p className="mt-3 flex items-center gap-1.5 text-xs text-neutral-500">
            <svg viewBox="0 0 24 24" className="h-3.5 w-3.5 text-gold/70" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
              <path d="M12 21s7-6.1 7-11a7 7 0 1 0-14 0c0 4.9 7 11 7 11Z" strokeLinejoin="round" />
            </svg>
            {store.address}
          </p>
        )}
      </div>
    </section>
  )
}

