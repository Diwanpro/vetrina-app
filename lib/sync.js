import { supabase } from '@/lib/supabase'
import { getAppContext } from '@/lib/app-context'
import { catalogKey, localGet, localRows, localPut, saveCatalog } from '@/lib/local-db'

let running
export function syncPending() {
  if (!running) running = sync().finally(() => { running = null })
  return running
}
async function sync() {
  if (!navigator.onLine) return
  const ctx = await getAppContext()
  if (ctx.offline) return
  if (ctx.locked) throw new Error('فعّل الاشتراك لمزامنة الفواتير')
  const rows = (await localRows()).filter(row => row.auth_id === ctx.user.id && row.tenant_id === ctx.tenantId && row.staff_id === ctx.staffId && row.status !== 'synced')
  for (const row of rows.sort((a, b) => a.created_at.localeCompare(b.created_at))) {
    // Never relabel an old user's receipt with the newly logged-in account.
    if (ctx.role !== 'owner' && row.store_id !== ctx.assignedStoreId) continue
    if (!ctx.stores.some(store => store.id === row.store_id)) continue
    try {
      const response = row.kind === 'audit'
        ? await supabase.rpc('engine_sync_audit_for_staff', { p_store: row.store_id, p_tenant: row.tenant_id, p_id: row.local_id, p_action: row.action, p_details: row.details, p_device: row.device_info, p_staff: row.staff_id })
        : await supabase.rpc('engine_sync_sale_for_staff', {
          p_store: row.store_id, p_tenant: row.tenant_id, p_local_id: row.local_id,
          p_staff: row.staff_id, p_items: row.items, p_payment: row.payment_method, p_created_at: row.created_at,
        })
      if (response.error) throw response.error
      await localPut({ ...row, status: 'synced', synced_at: new Date().toISOString(), error: null })
    } catch (err) {
      await localPut({ ...row, status: 'error', error: err.message || 'فشلت المزامنة' })
      // Network/auth errors should not flood all subsequent rows with requests.
      if (!navigator.onLine || /fetch|network|JWT|session/i.test(err.message || '')) break
    }
  }
  window.dispatchEvent(new Event('vetrina:outbox'))
}
export async function cacheCatalog(ctx, products) {
  return saveCatalog(ctx, products)
}
export async function cachedCatalog(ctx) {
  const data = await localGet(catalogKey(ctx))
  if (!data) throw new Error('افتح نقطة البيع في هذا الفرع أثناء الاتصال لتجهيزها للعمل دون إنترنت')
  return data
}
