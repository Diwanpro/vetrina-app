export const ALL_BRANCHES = 'all'
export const TRIAL_DAYS = 7
export function trialStart(tenant) {
  const started = tenant?.trial_start_date ? new Date(tenant.trial_start_date).getTime() : NaN
  return Number.isNaN(started) ? null : started
}
// 7-day rule. The database computes the same thing (`public.trial_expired`);
// `tenant.trial_expired` from the session payload wins, and the date maths below
// is the fallback for payloads loaded before that flag existed.
export function trialExpired(tenant, now = new Date()) {
  if (!tenant || tenant.is_active === true) return false
  if (typeof tenant.trial_expired === 'boolean') return tenant.trial_expired
  const started = trialStart(tenant)
  if (started === null) return false
  return now.getTime() > started + TRIAL_DAYS * 86400000
}
// Days left in the trial; null when activated or when the start date is unknown.
export function trialDaysLeft(tenant, now = new Date()) {
  if (!tenant || tenant.is_active === true) return null
  const started = trialStart(tenant)
  if (started === null) return null
  return Math.max(0, TRIAL_DAYS - Math.floor((now.getTime() - started) / 86400000))
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
  if (['/dashboard/transfers', '/dashboard/users', '/dashboard/accounting'].some(route => path.startsWith(route))) return role === 'owner'
  if (['/dashboard/purchases', '/dashboard/suppliers', '/dashboard/products'].some(route => path.startsWith(route))) return role === 'owner' || role === 'manager'
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
