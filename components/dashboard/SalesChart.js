const DAYS = [
  { label: 'ثلاث', value: 42 },
  { label: 'أربع', value: 58 },
  { label: 'خميس', value: 35 },
  { label: 'جمعة', value: 72 },
  { label: 'سبت', value: 64 },
  { label: 'أحد', value: 28 },
  { label: 'إثنين', value: 50 },
]

export default function SalesChart() {
  const max = Math.max(...DAYS.map((d) => d.value))

  return (
    <section className="rounded-xl border border-white/5 bg-card p-3.5 shadow-[0_4px_18px_rgba(0,0,0,0.28)]">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-medium text-neutral-100">مبيعات آخر 7 أيام</h2>
        <span className="text-[11px] text-neutral-500">بيانات تجريبية</span>
      </div>
      <div className="flex items-end justify-between gap-1.5 h-36 px-1">
        {DAYS.map((day) => (
          <div key={day.label} className="flex h-full flex-1 flex-col items-center justify-end">
            <div
              className="w-full max-w-[28px] rounded-t-md bg-gradient-to-t from-[#8a7020] to-gold"
              style={{ height: `${(day.value / max) * 100}%` }}
            />
            <span className="mt-1.5 text-[10px] text-neutral-500">{day.label}</span>
          </div>
        ))}
      </div>
    </section>
  )
}
