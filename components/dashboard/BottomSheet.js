'use client'

import { useCallback, useEffect, useRef } from 'react'

/**
 * Shared «درج منزلق» (bottom sheet) for the dashboard.
 *
 * On a phone this is the natural shape for a short choice: it grows from the
 * thumb side, keeps the page behind it visible through the dimmed scrim, and
 * closes on tap-outside or Escape. On wider screens it is capped at `max-w-md`
 * and stays anchored to the bottom, matching the cart and checkout panels.
 *
 * Deliberately independent of the storefront's `components/store/Sheet.js`:
 * that one is styled by the store theme (`sf-*`), while the dashboard keeps its
 * own dark surface here. Nothing else is reused, so the two can evolve apart.
 *
 * A11y: the panel is a labelled dialog (`role="dialog"` + `aria-modal`), the
 * scrim carries an «إغلاق» label, focus moves into the sheet on open and
 * returns to the trigger on close, and Escape or a scrim tap closes it.
 */
export default function BottomSheet({
  open,
  onClose,
  title,
  children,
  labelledBy = 'bottom-sheet-title',
  closeLabel = 'إغلاق',
}) {
  const panelRef = useRef(null)
  const openerRef = useRef(null)
  // A ref, not a dependency: `onClose` is usually an inline arrow, so listing it
  // would re-run these effects on every render. The ref always points at the
  // latest callback, and the cleanup still removes the same listener.
  const onCloseRef = useRef(onClose)
  useEffect(() => { onCloseRef.current = onClose }, [onClose])

  // Restore the opener when the sheet unmounts, so keyboard/touch focus does
  // not land on <body> after a choice is made.
  useEffect(() => {
    if (open) openerRef.current = document.activeElement
    return () => {
      if (!open && openerRef.current?.focus) openerRef.current.focus()
    }
  }, [open])

  // Lock page scroll while the sheet is up, and release it on close.
  useEffect(() => {
    if (!open) return
    const previous = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const onKey = event => { if (event.key === 'Escape') onCloseRef.current?.() }
    window.addEventListener('keydown', onKey)
    return () => {
      document.body.style.overflow = previous
      window.removeEventListener('keydown', onKey)
    }
  }, [open])

  // Tap-outside: ignore the panel itself, and remember the opener so focus can
  // be handed back. The scrim is a real <button>, so it is focusable too.
  const onScrim = useCallback(event => {
    if (event.target !== event.currentTarget) return
    onClose?.()
  }, [onClose])

  useEffect(() => {
    if (!open) return
    // Focus the first focusable thing inside, else the panel itself.
    const node = panelRef.current
    if (!node) return
    const target = node.querySelector('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')
    if (target) target.focus()
    else node.focus()
  }, [open])

  if (!open) return null

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center">
      <button
        type="button"
        aria-label={closeLabel}
        onClick={onScrim}
        onPointerDown={event => { if (event.target === event.currentTarget) openerRef.current = event.target }}
        className="absolute inset-0 bg-black/70 backdrop-blur-sm"
      />
      <section
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        tabIndex={-1}
        className="relative flex max-h-[85vh] w-full max-w-md flex-col overflow-hidden rounded-t-2xl border border-gold/20 bg-[#171717] text-neutral-100 shadow-2xl outline-none"
      >
        <div className="flex shrink-0 items-center justify-between gap-3 border-b border-white/10 px-4 py-3">
          <h2 id={labelledBy} className="text-sm font-medium text-gold">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label={closeLabel}
            className="rounded-lg px-2 py-1 text-xs text-neutral-400 hover:bg-white/5 hover:text-white"
          >
            {closeLabel}
          </button>
        </div>
        <div className="overflow-y-auto px-4 py-3">
          {children}
        </div>
      </section>
    </div>
  )
}
