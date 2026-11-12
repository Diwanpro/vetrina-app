export default function KpiCard({ title, value, subtitle, icon: Icon, accent = 'gold', onClick }) {
  const accentClass =
    accent === 'red'
      ? 'text-red-300 bg-red-500/10'
      : accent === 'green'
        ? 'text-emerald-300 bg-emerald-500/10'
        : 'text-gold bg-gold/10'

  const body = (
    <>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-xs text-neutral-400">{title}</p>
          <p className="mt-1 text-lg font-bold tracking-wide text-gold">{value}</p>
        </div>
        <span className={`inline-flex h-8 w-8 items-center justify-center rounded-lg ${accentClass}`}>
          {Icon ? <Icon className="w-4 h-4" /> : null}
        </span>
      </div>
      <p className="mt-2 text-[11px] leading-relaxed text-neutral-500">{subtitle}</p>
    </>
  )

  const base = 'rounded-xl border border-white/5 bg-card p-3.5 text-right shadow-[0_4px_18px_rgba(0,0,0,0.28)]'

  // Without onClick this stays a plain article, exactly as before. With it the
  // whole card becomes a real button so the keyboard and screen readers get the
  // same affordance as a mouse.
  if (!onClick) return <article className={base}>{body}</article>

  return (
    <button
      type="button"
      onClick={onClick}
      aria-haspopup="dialog"
      className={`${base} w-full cursor-pointer transition hover:border-gold/30 hover:bg-white/[0.03] focus:outline-none focus-visible:ring-2 focus-visible:ring-gold/60`}
    >
      {body}
    </button>
  )
}
