// SERVER ONLY. Staff subscriptions never share the public customer table.
import { adminClient } from './store.js'

export function eligibleStaff(user, subscription) {
  return Boolean(user?.is_active !== false && user?.id === subscription.staff_id &&
    user?.tenant_id === subscription.tenant_id &&
    (user.role === 'owner' || (user.role === 'manager' && user.store_id === subscription.store_id)))
}

export async function staffSubscriptions(storeId, tenantId) {
  const client = adminClient()
  const { data, error } = await client.from('staff_push_subscriptions').select('id, staff_id, store_id, tenant_id, endpoint, p256dh, auth').eq('store_id', storeId).eq('tenant_id', tenantId)
  if (error) throw error
  if (!data?.length) return []
  const users = await client.from('users').select('id, tenant_id, store_id, role, is_active').in('id', [...new Set(data.map(row => row.staff_id))])
  if (users.error) throw users.error
  return data.filter(row => eligibleStaff(users.data.find(user => user.id === row.staff_id), row))
}

export function buildOosPush(event) {
  const clean = value => String(value || '').replace(/[\u0000-\u001f]/g, ' ').slice(0, 100)
  const url = `/dashboard/alerts?store=${encodeURIComponent(event.store_id)}`
  return {
    title: 'نفاد المخزون · ' + clean(event.store_name),
    body: `${clean(event.product_name)} · المقاس: ${clean(event.size)} · اللون: ${clean(event.color)}`,
    url, data: { url }, icon: '/icon-192.png', badge: '/icon-192.png',
    tag: `oos-${event.id}`, actions: [{ action: 'open', title: 'فتح التنبيهات' }],
  }
}

// Restrict staff endpoints to browser push services, not arbitrary HTTPS hosts.
export function validStaffEndpoint(endpoint) {
  try {
    const url = new URL(endpoint)
    return url.protocol === 'https:' && !url.username && !url.password && !url.port &&
      (url.hostname === 'fcm.googleapis.com' || url.hostname === 'updates.push.services.mozilla.com' ||
       url.hostname === 'web.push.apple.com' || url.hostname.endsWith('.push.apple.com') ||
       url.hostname.endsWith('.notify.windows.com'))
  } catch { return false }
}
