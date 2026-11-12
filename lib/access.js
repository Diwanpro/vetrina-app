export const ALL_BRANCHES = 'all'
export const TRIAL_DAYS = 7
export const TRIAL_TIME_ZONE = 'Africa/Algiers'
// The trial runs to midnight at the end of its 7th calendar day, in the shop's
// time zone. `public.trial_expiry` in the database is authoritative; these
// helpers mirror it so the UI can render without a round trip.
const DAY_MS = 86400000
const formatter = new Intl.DateTimeFormat('en-US', {
  timeZone: TRIAL_TIME_ZONE, hour12: false,
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit',
})
// Milliseconds the zone is ahead of UTC at the given instant.
function zoneOffset(date) {
  const parts = formatter.formatToParts(date).reduce((all, part) => ({ ...all, [part.type]: part.value }), {})
  const wall = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day),
    Number(parts.hour) % 24, Number(parts.minute), Number(parts.second))
  return wall - (date.getTime() - date.getMilliseconds())
}
// "Wall clock" milliseconds: the zone's local time expressed as if it were UTC.
// Day arithmetic on this value is immune to DST shifts.
function wallTime(date) { return date.getTime() + zoneOffset(date) }
// Converts a wall-clock value back to a real instant, resolving the offset at
// the destination (which may differ across a DST boundary).
function fromWall(wall) {
  const first = wall - zoneOffset(new Date(wall))
  return new Date(wall - zoneOffset(new Date(first)))
}
// When the trial ends: local midnight after the last trial day.
export function trialEndsAt(tenant) {
  const started = tenant?.trial_start_date ? new Date(tenant.trial_start_date) : null
  if (!started || Number.isNaN(started.getTime())) return null
  const midnight = Math.floor(wallTime(started) / DAY_MS) * DAY_MS
  return fromWall(midnight + TRIAL_DAYS * DAY_MS)
}
// The server flag (`tenant.trial_expired`) always wins, so a tampered clock
// cannot unlock a trial the database has already closed.
export function trialExpired(tenant, now = new Date()) {
  if (!tenant || tenant.is_active === true) return false
  if (typeof tenant.trial_expired === 'boolean') return tenant.trial_expired
  const ends = trialEndsAt(tenant)
  if (!ends) return false
  return now.getTime() >= ends.getTime()
}
// Whole calendar days still usable; null when activated or the date is unknown.
export function trialDaysLeft(tenant, now = new Date()) {
  if (!tenant || tenant.is_active === true) return null
  const ends = trialEndsAt(tenant)
  if (!ends) return null
  const days = Math.round((Math.floor(wallTime(ends) / DAY_MS) - Math.floor(wallTime(now) / DAY_MS)))
  return Math.max(0, days)
}
// A tenant is locked when its trial has been used up, or when a paid
// subscription was explicitly ended and has been switched off.
export function subscriptionLocked(tenant, now = new Date()) {
  if (trialExpired(tenant, now)) return true
  return tenant?.is_active === false && Boolean(tenant.subscription_end_date) && new Date(tenant.subscription_end_date).getTime() < now.getTime()
}
export function selectScope(profile, stores, selected) {
  if (!profile?.tenantId || !['owner', 'manager', 'employee'].includes(profile.role)) throw new Error('ملف الموظف غير صالح')
  if (profile.role !== 'owner') {
    if (!profile.assignedStoreId || !stores.some(store => store.id === profile.assignedStoreId)) throw new Error('لم يتم تعيين فرع صالح لهذا الموظف. تواصل مع المالك.')
    return { storeId: profile.assignedStoreId, storeIds: [profile.assignedStoreId], allBranches: false }
  }
  if (selected === ALL_BRANCHES) return { storeId: null, storeIds: stores.map(store => store.id), allBranches: true }
  const storeId = stores.find(store => store.id === selected)?.id || stores.find(store => store.id === profile.assignedStoreId)?.id || stores[0]?.id || null
  return { storeId, storeIds: storeId ? [storeId] : [], allBranches: false }
}
export function scopeQuery(query, ctx, column = 'store_id', tenantColumn = 'stores.tenant_id') {
  if (!ctx?.tenantId || !ctx.storeIds?.length) throw new Error('لا يوجد فرع متاح للعرض')
  if (ctx.role !== 'owner' && (ctx.allBranches || ctx.storeId !== ctx.assignedStoreId)) throw new Error('غير مصرح بتغيير الفرع')
  return ctx.allBranches ? query.eq(tenantColumn, ctx.tenantId) : query.eq(column, ctx.storeId)
}
export function routeAllowed(role, path) {
  // Grouped pages are containers: any role may open the page, and the tab strip
  // filters out the individual tabs that role is not allowed to see.
  if (['/dashboard/operations', '/dashboard/customers-credit', '/dashboard/stock', '/dashboard/management'].some(route => path === route)) {
    return ['owner', 'manager', 'employee'].includes(role)
  }
  // Clearing a cheque moves real money into or out of the drawer, so it is
  // owner/manager only rather than the default everyone-can-see rule.
  if (path.startsWith('/dashboard/collections')) return role === 'owner' || role === 'manager'
  if (['/dashboard/transfers', '/dashboard/users', '/dashboard/accounting'].some(route => path.startsWith(route))) return role === 'owner'
  // Offers change what customers are charged, so staff cannot author them.
  if (['/dashboard/purchases', '/dashboard/suppliers', '/dashboard/products', '/dashboard/offers', '/dashboard/looks'].some(route => path.startsWith(route))) return role === 'owner' || role === 'manager'
  return ['owner', 'manager', 'employee'].includes(role)
}
export function csvText(columns, rows) {
  const escape = value => {
    let text = value == null ? '' : String(value)
    // Prevent spreadsheet formula injection, including leading control chars.
    if (/^[\s\u0000-\u001f]*[=+@-]/.test(text)) text = `'${text}`
    return `"${text.replaceAll('"', '""')}"`
  }
  return '\uFEFF' + [columns.map(column => escape(column.label)), ...rows.map(row => columns.map(column => escape(row[column.key])))].map(row => row.join(',')).join('\r\n')
}
export function isNetworkError(error) {
  return error?.name === 'AuthRetryableFetchError' || error?.name === 'AbortError' || /failed to fetch|network request failed|load failed|fetch failed|request timed out/i.test(error?.message || '')
}
