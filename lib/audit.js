import { getAppContext } from '@/lib/app-context'
import { localPut } from '@/lib/local-db'
import { syncPending } from '@/lib/sync'

export async function logAction(action, details) {
  const ctx = await getAppContext()
  if (!ctx.storeId || ctx.locked) throw new Error('تعذر تحديد مستخدم وفرع نشط للتدقيق')
  await localPut({
    local_id: crypto.randomUUID(), kind: 'audit', status: 'pending', created_at: new Date().toISOString(),
    auth_id: ctx.user.id, staff_id: ctx.staffId, tenant_id: ctx.tenantId, store_id: ctx.storeId,
    action, details, device_info: navigator.userAgent,
  })
  window.dispatchEvent(new Event('vetrina:outbox'))
  if (navigator.onLine) syncPending().catch(() => {})
}
