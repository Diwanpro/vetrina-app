'use client'

// Native dropdowns ignore most CSS in the closed state and several browsers
// paint the option list white. `select-field` (see app/globals.css) supplies the
// dark background for the popup; the Tailwind classes below cover the control.
export const fieldClass = 'select-field w-full rounded-lg border border-[#D4AF37]/40 bg-[#1A1A1A] px-3 py-2 text-sm text-white outline-none focus:border-gold disabled:opacity-50'
export const selectClass = `${fieldClass} appearance-none`
export const primaryClass = 'rounded-lg bg-gold px-4 py-2 text-sm font-medium text-[#121212] disabled:opacity-50'
export const secondaryClass = 'rounded-lg border border-white/10 bg-[#222] px-3 py-2 text-sm text-neutral-200 disabled:opacity-50'
export function Notice({ error, success }) {
  return <>{error && <p role="alert" className="mb-4 rounded-lg border border-red-800/40 bg-red-950/20 p-3 text-sm text-red-200">{error}</p>}
    {success && <p role="status" className="mb-4 rounded-lg border border-emerald-800/40 bg-emerald-950/20 p-3 text-sm text-emerald-200">{success}</p>}</>
}
export function Modal({ title, onClose, busy, children, wide = false }) {
  return <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4">
    <section role="dialog" aria-modal="true" aria-label={title} className={`max-h-[90vh] w-full ${wide ? 'max-w-4xl' : 'max-w-lg'} overflow-y-auto rounded-2xl border border-gold/20 bg-[#171717] p-5 text-neutral-100 shadow-2xl`}>
      <div className="mb-5 flex items-center justify-between gap-3">
        <h2 className="text-base font-medium text-gold">{title}</h2>
        <button type="button" disabled={busy} onClick={onClose} className="text-sm text-neutral-400 disabled:opacity-50">إغلاق</button>
      </div>
      {children}
    </section>
  </div>
}
