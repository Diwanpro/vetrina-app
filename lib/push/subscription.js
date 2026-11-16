// Pure validation for customer Web Push subscriptions (v3.1).

import { normalizeSlug } from '../pwa/manifest.js'

export function normalizeSubscription(input) {
  const value = input?.subscription || input
  const endpoint = String(value?.endpoint || '').trim()
  const keys = value?.keys || {}
  const p256dh = String(keys.p256dh || '').trim()
  const auth = String(keys.auth || '').trim()

  let parsed
  try { parsed = new URL(endpoint) } catch { throw new Error('رابط الاشتراك غير صالح') }
  // Push services are always HTTPS. Never persist javascript:, data: or file:.
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('رابط الاشتراك غير صالح')
  }
  if (parsed.protocol !== 'https:') throw new Error('رابط الاشتراك يجب أن يبدأ بـ https')
  if (endpoint.length > 1000) throw new Error('رابط الاشتراك طويل جداً')
  if (!p256dh || !auth || p256dh.length > 500 || auth.length > 200) {
    throw new Error('مفاتيح الاشتراك غير صالحة')
  }
  return { endpoint, p256dh, auth }
}

export function normalizePushKind(value) {
  return value === 'offer' ? 'offer' : 'product'
}

export function isValidUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value || ''))
}

export { normalizeSlug }
