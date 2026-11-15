// Pure Web Push copy builder (v3.1).
//
// Every notification contains: the store name, a catchy title, and a direct
// store link (both in the visible body and in data.url for notificationclick).

import { normalizeSlug, safeStoreIcon } from '../pwa/manifest.js'

function clean(value, max) {
  return String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max)
}

export function safeOrigin(value) {
  const text = String(value || '').trim().replace(/\/+$/, '')
  try {
    const url = new URL(text)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return ''
    return url.origin
  } catch { return '' }
}

export function buildPushMessage({
  storeName,
  storeSlug,
  origin,
  kind = 'product',
  itemName = '',
  logoUrl = '',
  now = Date.now(),
} = {}) {
  const name = clean(storeName, 60) || 'متجر Vetrina'
  const slug = normalizeSlug(storeSlug) || 'store'
  const base = safeOrigin(origin)
  const url = base ? `${base}/s/${encodeURIComponent(slug)}` : `/s/${encodeURIComponent(slug)}`
  const item = clean(itemName, 80)
  const offer = kind === 'offer'
  const title = offer ? `🎉 عرض جديد في ${name}` : `✨ وصل حديثاً إلى ${name}`
  const lead = offer
    ? (item ? `انطلق عرض «${item}» في ${name}` : `عروض جديدة بانتظارك في ${name}`)
    : (item ? `قطعة جديدة: ${item} في ${name}` : `تشكيلة جديدة وصلت إلى ${name}`)
  const body = `${lead} · افتح المتجر الآن: ${url}`.slice(0, 360)

  return {
    title,
    body,
    url,
    icon: safeStoreIcon(logoUrl) || '/icon-192.png',
    badge: '/icon-192.png',
    tag: `vetrina-${slug}-${offer ? 'offer' : 'product'}-${now}`,
    data: { url },
    actions: [{ action: 'open', title: 'افتح المتجر' }],
  }
}
