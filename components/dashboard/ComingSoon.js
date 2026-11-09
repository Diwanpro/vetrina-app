import DashboardShell from './DashboardShell'

export default function ComingSoon({ active, title }) {
  return (
    <DashboardShell active={active}>
      <div className="rounded-xl border border-dashed border-white/10 bg-card p-8 text-center">
        <h1 className="text-base font-medium text-neutral-100">{title}</h1>
        <p className="mt-2 text-sm text-neutral-500">قيد التطوير</p>
      </div>
    </DashboardShell>
  )
}
