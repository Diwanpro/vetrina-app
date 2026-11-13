'use client'

/**
 * The storefront/POS tab rail, in one place.
 *
 * The public store and the POS are the same shop seen from two sides, so their
 * navigation must not drift: a merchant looking for "the offers tab" should
 * find the identical chip in both. Both screens render this component, so the
 * only possible difference between them is the data behind it.
 *
 * Horizontally scrollable rather than wrapped: a shop with twelve categories
 * would otherwise push the grid below the fold on a phone.
 *
 * A tab with nothing behind it is not drawn. An empty عروض tab promises a
 * discount the shop is not running, and an empty إطلالات tab promises an
 * outfit that does not exist — both are worse than no tab at all.
 *
 * `chips` entries are { key, label, badge?, accent? }; the caller decides what
 * the fixed keys mean, this component only draws them.
 */
export default function StoreTabRail({ chips, active, onSelect, ariaLabel = 'أقسام المتجر' }) {
  return (
    <nav aria-label={ariaLabel} className="sf-rail flex gap-2 overflow-x-auto px-1 pb-1">
      {chips.map(chip => {
        const isActive = active === chip.key
        return (
          <button
            key={chip.key}
            type="button"
            aria-current={isActive ? 'page' : undefined}
            onClick={() => onSelect(chip.key)}
            className={`flex min-h-10 shrink-0 items-center gap-1.5 rounded-full border px-4 text-sm transition ${
              isActive
                ? 'border-gold bg-gold/15 font-medium text-gold'
                : chip.accent
                  ? 'border-gold/35 bg-gold/[0.07] text-gold/90'
                  : 'border-white/10 bg-white/5 text-neutral-300'
            }`}
          >
            {chip.label}
            {chip.badge ? (
              <span className={`rounded-full px-1.5 text-[10px] font-bold ${
                isActive ? 'bg-gold text-[#121212]' : 'bg-white/10 text-neutral-300'
              }`}>
                {chip.badge}
              </span>
            ) : null}
          </button>
        )
      })}
    </nav>
  )
}

/**
 * Builds the chip list for a rail: الكل, then عروض and إطلالات when they have
 * content, then the shop's categories.
 *
 * Kept beside the component because both screens need exactly this list, and
 * the "hide it when empty" rule is the part that is easy to get wrong.
 */
export function buildStoreTabs({ categories = [], offerCount = 0, lookCount = 0, loadingLooks = false }) {
  return [
    { key: 'all', label: 'الكل' },
    ...(offerCount > 0 ? [{ key: 'offers', label: 'عروض', badge: offerCount, accent: true }] : []),
    // While looks are still loading the tab is shown without a count, so the
    // layout does not jump sideways once they arrive.
    ...(loadingLooks || lookCount > 0
      ? [{ key: 'looks', label: 'إطلالات', badge: loadingLooks ? null : lookCount }]
      : []),
    ...categories.map(value => ({ key: value, label: value })),
  ]
}
