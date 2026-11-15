// Dynamic, per-branch Web App Manifest builder (v3.1).
//
// The dashboard keeps its static public/manifest.json. A customer opening
// /s/<slug> gets a manifest whose name, short name, start URL, description,
// theme colour and icon come from THAT branch's row in get_store_by_slug.

import { resolveStoreTheme, themeColors } from '../store-theme.js'

export function safeStoreIcon(value) {
  const text = String(value ?? '').trim().slice(0, 600)
  if (!text) return ''
  if (/^https?:\/\//i.test(text)) return text
  // Same-origin absolute path only; "//evil.example" is an external URL.
  if (text.startsWith('/') && !text.startsWith('//')) return text
  return ''
}

export function cleanStoreName(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, 60) || 'متجر Vetrina'
}

export function normalizeSlug(value) {
  return String(value ?? '').trim().replace(/[^A-Za-z0-9._~-]/g, '-').slice(0, 120)
}

export function manifestHref(slug) {
  return `/api/store/${encodeURIComponent(normalizeSlug(slug))}/manifest`
}

export function buildStoreManifest({ slug, store = {}, theme } = {}) {
  const safeSlug = normalizeSlug(slug || store.slug)
  const startUrl = safeSlug ? `/s/${encodeURIComponent(safeSlug)}` : '/'
  const name = cleanStoreName(store.name)
  const shortName = cleanStoreName(name).slice(0, 24)
  const effectiveTheme = theme || resolveStoreTheme(store.store_type, store.theme_key)
  const colors = themeColors(effectiveTheme)
  const logo = safeStoreIcon(store.logo_url)
  const icons = [
    ...(logo ? [{ src: logo, sizes: 'any', type: 'image/png', purpose: 'any' }] : []),
    { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
    { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
    { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
  ]

  return {
    id: startUrl,
    name,
    short_name: shortName,
    description: `تسوّق من ${name} عبر Vetrina · الدفع عند الاستلام`,
    start_url: startUrl,
    scope: '/',
    display: 'standalone',
    orientation: 'portrait',
    lang: 'ar',
    dir: 'rtl',
    theme_color: colors.theme,
    background_color: colors.background,
    icons,
    shortcuts: [
      {
        name: `تسوّق من ${shortName}`,
        short_name: 'تسوّق',
        url: startUrl,
        icons: [{ src: '/icon-192.png', sizes: '192x192' }],
      },
    ],
    prefer_related_applications: false,
  }
}
