// Half-open local calendar periods, serialized to UTC for PostgreSQL.
export function accountingRange(period, now = new Date()) {
  if (!['month', 'year', 'all'].includes(period)) throw new Error('Invalid accounting period')
  const from = period === 'all' ? null : new Date(now.getFullYear(), period === 'year' ? 0 : now.getMonth(), 1).toISOString()
  const to = period === 'all' ? now.toISOString() : new Date(now.getFullYear() + (period === 'year' ? 1 : 0), period === 'year' ? 0 : now.getMonth() + 1, 1).toISOString()
  return { from, to }
}
