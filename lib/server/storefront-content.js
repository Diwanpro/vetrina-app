import 'server-only'
import { createClient } from '@supabase/supabase-js'

const BUCKET = 'storefront-assets'
const SIGNED_SECONDS = 300
const UUID = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i
const IMAGE_NAME = /^[a-zA-Z0-9_-]{1,128}\.(?:jpe?g|png|webp)$/

function clientWithKey(key, signal) {
  // Stateless on purpose: even a merchant visiting the public shop reads as anon.
  // No request cookies, Authorization headers, Next data cache or upstream redirects.
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, key, {
    accessToken: async () => null,
    db: { retry: false },
    global: { fetch: (url, init) => fetch(url, { ...init, cache: 'no-store', redirect: 'error', signal }) },
  })
}

function safeHref(value) {
  if (typeof value !== 'string' || !value || /[\s\\\u0000-\u001f\u007f-\u009f]/.test(value)) return null
  if (value.startsWith('/') && !value.startsWith('//')) return value
  if (!/^https?:\/\/[^/?#]/i.test(value)) return null
  try { return new URL(value).hostname ? value : null } catch { return null }
}

async function publishedGroup(reader, store, table, limit, signingBucket) {
  const { tenant_id, store_id } = store
  const { data, error } = await reader.from(table).select('id,tenant_id,store_id,status,title,image_url,link_url')
    .eq('tenant_id', tenant_id).eq('store_id', store_id).eq('status', 'published').not('image_url', 'is', null)
    .order('sort_order').order('id').limit(limit)
  if (error) throw error

  // Recheck the actual rows at the privilege boundary. The suffix must be a
  // single allowed filename, not another folder, URL, or encoded path.
  const prefix = `${tenant_id}/${store_id}/`
  const rows = data.filter(row => row.tenant_id === tenant_id && row.store_id === store_id && row.status === 'published'
    && typeof row.title === 'string' && row.title.trim() && typeof row.image_url === 'string'
    && row.image_url.startsWith(prefix) && IMAGE_NAME.test(row.image_url.slice(prefix.length))).slice(0, limit)
  if (!rows.length) return []

  const paths = new Set(rows.map(row => row.image_url))
  const result = await signingBucket().createSignedUrls([...paths], SIGNED_SECONDS)
  if (result.error) throw result.error
  const urls = new Map(result.data.filter(item => paths.has(item.path) && !item.error && item.signedUrl)
    .map(item => [item.path, item.signedUrl]))
  // Return a display DTO, never raw DB rows or a URL supplied by the caller.
  return rows.filter(row => urls.has(row.image_url)).map(row => ({
    id: row.id, title: row.title, imageUrl: urls.get(row.image_url), href: safeHref(row.link_url),
  }))
}

export async function readStorefrontContent(slug, requestSignal) {
  const normalized = typeof slug === 'string' ? slug.trim().toLowerCase() : ''
  // Same format as stores_slug_format. Never rewrite an invalid slug into a real one.
  if (!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(normalized)) return null
  const signal = AbortSignal.any([requestSignal, AbortSignal.timeout(8000)])
  const reader = clientWithKey(process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY, signal)
  const { data: store, error } = await reader.rpc('get_store_by_slug', { p_slug: normalized })
  if (error) throw error
  // The public RPC returns null for disabled/missing stores. Both identifiers
  // come from this lookup, not the browser. Visitor RLS still applies to both reads.
  if (store?.slug !== normalized || !UUID.test(store.tenant_id) || !UUID.test(store.store_id)) return null

  let bucket
  const signingBucket = () => (bucket ??= clientWithKey(process.env.SUPABASE_SERVICE_ROLE_KEY, signal).storage.from(BUCKET))
  // Bound the homepage payload/signing work and isolate the two surfaces: a
  // failed table or batch of signatures must not discard the other collection.
  const [banners, sections] = await Promise.allSettled([
    publishedGroup(reader, store, 'storefront_banners', 12, signingBucket),
    publishedGroup(reader, store, 'storefront_sections', 24, signingBucket),
  ])
  if (banners.status === 'rejected' && sections.status === 'rejected') throw new Error('Content unavailable')
  return { banners: banners.value || [], sections: sections.value || [] }
}
