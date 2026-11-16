// Public-storefront Theme Engine (v3.1).
//
// The theme is resolved from the BRANCH specialty, never from the account:
//   * women's branch  => feminine luxury theme, always;
//   * men's branch    => current classic dark-gold theme, always;
//   * mixed branch    => the merchant's chosen default theme.
//
// Pure helpers only: safe to import from server routes, client components and
// the Node test suite.

import { STORE_TYPES, normalizeStoreType } from './store-catalog.js'

export const STORE_THEMES = Object.freeze({
  CLASSIC: 'classic',
  FEMININE: 'feminine',
})

export const THEME_OPTIONS = Object.freeze([
  { value: STORE_THEMES.CLASSIC, label: 'القالب الكلاسيكي (الحالي)' },
  { value: STORE_THEMES.FEMININE, label: 'القالب الأنثوي الفاخر' },
])

export const THEME_LABELS = Object.freeze({
  [STORE_THEMES.CLASSIC]: 'القالب الكلاسيكي',
  [STORE_THEMES.FEMININE]: 'القالب الأنثوي الفاخر',
})

export const THEME_COLORS = Object.freeze({
  [STORE_THEMES.CLASSIC]: Object.freeze({ theme: '#121212', background: '#121212' }),
  [STORE_THEMES.FEMININE]: Object.freeze({ theme: '#3a2130', background: '#1b1219' }),
})

export function isStoreTheme(value) {
  return value === STORE_THEMES.CLASSIC || value === STORE_THEMES.FEMININE
}

export function normalizeStoreTheme(value) {
  return isStoreTheme(value) ? value : STORE_THEMES.CLASSIC
}

/** Specialty wins; only «متعدد» lets the merchant pick the default template. */
export function resolveStoreTheme(storeType, preferredTheme) {
  const type = normalizeStoreType(storeType)
  if (type === STORE_TYPES.WOMENS) return STORE_THEMES.FEMININE
  if (type === STORE_TYPES.MENS) return STORE_THEMES.CLASSIC
  return normalizeStoreTheme(preferredTheme)
}

export function themeClass(theme) {
  return `vetrina-theme-${normalizeStoreTheme(theme)}`
}

export function themeColors(theme) {
  return THEME_COLORS[normalizeStoreTheme(theme)]
}
