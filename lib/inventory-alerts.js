// Master Inventory & Branch Stock (v3.2).
//
// The warehouse and the showroom are deliberately two different scopes. The
// browser never decides which one a row belongs to: these constants mirror the
// CHECK constraints in migration 020, and the OOS message copy lives here so
// the dashboard, the SQL RPC and the tests speak the same Arabic.

export const INVENTORY_SCOPES = Object.freeze({
  MASTER: 'master',
  BRANCH: 'branch',
})

export const INVENTORY_SCOPE_LABELS = Object.freeze({
  [INVENTORY_SCOPES.MASTER]: 'مخزون المستودع (Master)',
  [INVENTORY_SCOPES.BRANCH]: 'مخزون الفرع / المعرض (Branch)',
})

export const OOS_STATUSES = Object.freeze({
  MASTER: 'master',
  OTHER_BRANCH: 'other_branch',
  UNAVAILABLE: 'unavailable',
})

export function isMasterScope(value) {
  return value === INVENTORY_SCOPES.MASTER
}

export function isBranchScope(value) {
  return value === INVENTORY_SCOPES.BRANCH
}

export function scopeLabel(value) {
  return INVENTORY_SCOPE_LABELS[value] || INVENTORY_SCOPE_LABELS[INVENTORY_SCOPES.BRANCH]
}

/**
 * The three exact branches of the merchant's OOS decision tree:
 *  1. same colour/size exists in the master warehouse → one-click replenish;
 *  2. otherwise another branch has it → name that branch and the size;
 *  3. otherwise → hide the sell-out product until it is refilled.
 */
export function oosStatus({ masterQuantity = 0, otherBranchName = '' } = {}) {
  if (Number(masterQuantity) > 0) return OOS_STATUSES.MASTER
  if (String(otherBranchName || '').trim()) return OOS_STATUSES.OTHER_BRANCH
  return OOS_STATUSES.UNAVAILABLE
}

export function oosMessage({ masterQuantity = 0, otherBranchName = '', size = '' } = {}) {
  const qty = Math.max(0, Math.round(Number(masterQuantity) || 0))
  const branch = String(otherBranchName || '').trim()
  const measured = String(size || '').trim() || '—'
  if (qty > 0) {
    return `متوفر في المستودع الرئيسي بكمية ${qty} قطعة. اضغط «إضافة إلى المعرض» لتنتقل الكمية فوراً.`
  }
  if (branch) return `متوفر في فرع ${branch} بمقاس ${measured}`
  return 'المنتج غير متوفر نهائياً، سيتم إخفاؤه من المتجر حتى إعادة التعبئة'
}

export function canReplenishFromMaster(alert = {}) {
  return Number(alert.master_quantity || alert.masterQuantity || 0) > 0
}

export function oosActionLabel(alert = {}) {
  const qty = Math.max(0, Math.round(Number(alert.master_quantity || alert.masterQuantity || 0)))
  return qty ? `إضافة إلى المعرض (${qty} قطعة)` : 'إضافة إلى المعرض'
}
