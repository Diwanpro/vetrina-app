// A labelled section, not a destination: only its child links navigate.
export default function NavGroup({ label, children }) {
  return (
    <div role="group" aria-label={label} className="w-full space-y-1 rounded-xl border border-white/10 bg-white/[0.02] p-2 md:px-0.5 md:py-1.5">
      <p className="px-1 py-1 text-xs font-medium text-gold md:px-0 md:text-center md:text-[10px] md:leading-tight">{label}</p>
      {children}
    </div>
  )
}
