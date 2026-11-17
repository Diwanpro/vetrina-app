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
  // Phase 1: registered so the engine recognises the name. It has NO visual
  // design yet — resolveStoreTheme() still maps it to classic until Phase 2.
  MASCULINE: 'masculine',
})

// Every theme name the engine knows about, including ones with no design yet.
export const REGISTERED_THEMES = Object.freeze([
  STORE_THEMES.CLASSIC,
  STORE_THEMES.FEMININE,
  STORE_THEMES.MASCULINE,
])

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

// Phase 1: a name can be registered without having a design yet.
export function isRegisteredTheme(value) {
  return REGISTERED_THEMES.includes(value)
}

// Only themes that actually have a visual design resolve to themselves.
// Anything else — including the not-yet-designed masculine — falls back to
// classic, which is the safe margin required by Phase 1.
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

/**
 * Single source of truth for reading a branch's theme.
 *
 * The public storefront and the dashboard context both resolve through this
 * helper (directly or via resolveStoreTheme), so the fallback rules live in
 * one place: a missing or unknown theme_key always resolves to classic.
 */
export function readBranchTheme(storeType, preferredTheme) {
  const type = normalizeStoreType(storeType)
  const themeKey = normalizeStoreTheme(preferredTheme)
  return { storeType: type, themeKey, storeTheme: resolveStoreTheme(type, themeKey) }
}

export function themeClass(theme) {
  return `vetrina-theme-${normalizeStoreTheme(theme)}`
}

export function themeColors(theme) {
  return THEME_COLORS[normalizeStoreTheme(theme)]
}
