// Dynamic per-branch Web App Manifest (v3.1).
//
// /s/<slug> links THIS route instead of the static dashboard manifest, so the
// installed app carries the merchant/branch name, logo, start URL and theme.
// Only the public definer RPC get_store_by_slug is used; no service key here.

import { publicRpc } from '@/lib/public-store'
import { normalizeSlug, buildStoreManifest } from '@/lib/pwa/manifest'
import { resolveStoreTheme } from '@/lib/store-theme'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(_request, { params }) {
  const { slug } = await params
  const safeSlug = normalizeSlug(slug)
  const { data } = await publicRpc('get_store_by_slug', { p_slug: safeSlug })
  const store = data || {}
  const theme = resolveStoreTheme(store.store_type, store.theme_key)
  const manifest = buildStoreManifest({ slug: safeSlug, store, theme })

  return Response.json(manifest, {
    headers: {
      'Content-Type': 'application/manifest+json; charset=utf-8',
      'Cache-Control': 'public, max-age=0, must-revalidate',
    },
  })
}
