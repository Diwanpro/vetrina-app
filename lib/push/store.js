// SERVER-ONLY branch-scoped subscription storage (v3.1).
//
// The browser never touches public.push_subscriptions: RLS is enabled with no
// policies and the table is granted to service_role only. The store id/tenant
// are resolved through the public definer RPC get_store_by_slug, so a customer
// can subscribe to that branch — and only that branch.

import { createClient } from '@supabase/supabase-js'
import { publicRpc } from '../public-store.js'

export function adminClient() {
  const url = String(process.env.NEXT_PUBLIC_SUPABASE_URL || '').trim()
  const serviceKey = String(process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim()
  if (!url || !serviceKey) throw new Error('إعدادات خادم الإشعارات غير مكتملة')
  return createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  })
}

export async function getStoreBySlug(slug) {
  const { data, error } = await publicRpc('get_store_by_slug', { p_slug: slug })
  if (error) throw new Error('تعذر التحقق من المتجر')
  return data || null
}

export async function saveSubscription(slug, subscription, userAgent = '') {
  const store = await getStoreBySlug(slug)
  if (!store?.store_id) throw new Error('المتجر غير موجود')
  const client = adminClient()
  const { error } = await client.from('push_subscriptions').upsert({
    store_id: store.store_id,
    tenant_id: store.tenant_id,
    endpoint: subscription.endpoint,
    p256dh: subscription.p256dh,
    auth: subscription.auth,
    user_agent: String(userAgent || '').slice(0, 300) || null,
    updated_at: new Date().toISOString(),
  }, { onConflict: 'endpoint' })
  if (error) throw new Error('تعذر حفظ اشتراك الإشعارات')
  return { storeId: store.store_id, storeName: store.name }
}

export async function removeSubscription(slug, endpoint) {
  const store = await getStoreBySlug(slug)
  if (!store?.store_id) return { ok: true }
  const client = adminClient()
  const { error } = await client.from('push_subscriptions')
    .delete()
    .eq('store_id', store.store_id)
    .eq('endpoint', String(endpoint).slice(0, 1000))
  if (error) throw new Error('تعذر إيقاف الاشتراك')
  return { ok: true }
}

export async function getStoreById(storeId) {
  const client = adminClient()
  const { data, error } = await client.from('stores')
    .select('id, name, slug, logo_url, store_type, theme_key')
    .eq('id', storeId)
    .maybeSingle()
  if (error) throw new Error('تعذر قراءة بيانات الفرع')
  return data
}

export async function subscriptionsForStore(storeId) {
  const client = adminClient()
  const { data, error } = await client.from('push_subscriptions')
    .select('id, endpoint, p256dh, auth')
    .eq('store_id', storeId)
  if (error) throw new Error('تعذر قراءة مشتركي الفرع')
  return Array.isArray(data) ? data : []
}

export async function deleteSubscriptions(ids) {
  if (!ids.length) return
  const client = adminClient()
  const { error } = await client.from('push_subscriptions').delete().in('id', ids)
  if (error) throw new Error('تعذر تنظيف الاشتراكات المنتهية')
}
