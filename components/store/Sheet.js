'use client'

import { useEffect } from 'react'

/**
 * Bottom sheet used by the product view and the cart. On a phone this is the
 * natural shape: it grows from the thumb side, keeps the page behind it
 * visible through the blur, and closes on tap-outside or Escape.
 */
export default function Sheet({ open, onClose, children, labelledBy, full = false }) {
  useEffect(() => {
    if (!open) return
    const previous = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const onKey = event => { if (event.key === 'Escape') onClose?.() }
    window.addEventListener('keydown', onKey)
    return () => {
      document.body.style.overflow = previous
      window.removeEventListener('keydown', onKey)
    }
  }, [open, onClose])

  if (!open) return null

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center">
      <button
        type="button"
        aria-label="إغلاق"
        onClick={onClose}
        className="sf-fade-in absolute inset-0 bg-black/70 backdrop-blur-sm"
      />
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        className={`sf-sheet relative flex w-full max-w-lg flex-col overflow-hidden rounded-t-[28px] border border-white/10 border-b-0 bg-[#151515]/95 shadow-[0_-20px_60px_rgba(0,0,0,0.6)] backdrop-blur-2xl ${
          full ? 'h-[92vh]' : 'max-h-[92vh]'
        }`}
      >
        <div className="flex justify-center pt-3">
          <span aria-hidden="true" className="h-1 w-10 rounded-full bg-white/15" />
        </div>
        {children}
      </section>
    </div>
  )
}
