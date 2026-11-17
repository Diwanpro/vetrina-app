import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'

const read = file => fs.readFile(new URL(`../${file}`, import.meta.url), 'utf8')
const {
  STORE_THEMES, THEME_OPTIONS, THEME_COLORS, resolveStoreTheme,
  normalizeStoreTheme, themeClass, themeColors,
} = await import('../lib/store-theme.js')

// المرحلة 4: the public storefront theme follows the branch specialty.
test('women = feminine, men = masculine, mixed = merchant default', () => {
  // All three themes are merchant-selectable since the masculine theme_key
  // migration (202611170003) widened the check constraint and the RPCs.
  assert.deepEqual(THEME_OPTIONS.map(o => o.value), ['classic', 'feminine', 'masculine'])
  assert.equal(resolveStoreTheme('womens', 'classic'), STORE_THEMES.FEMININE)
  assert.equal(resolveStoreTheme('mens', 'feminine'), STORE_THEMES.MASCULINE)
  assert.equal(resolveStoreTheme('mixed', 'classic'), STORE_THEMES.CLASSIC)
  assert.equal(resolveStoreTheme('mixed', 'feminine'), STORE_THEMES.FEMININE)
  assert.equal(resolveStoreTheme('unknown', 'feminine'), STORE_THEMES.MASCULINE)
  assert.equal(normalizeStoreTheme('other'), STORE_THEMES.CLASSIC)
  assert.equal(normalizeStoreTheme('masculine'), STORE_THEMES.MASCULINE)
  assert.equal(themeClass('feminine'), 'vetrina-theme-feminine')
  assert.equal(themeClass('masculine'), 'vetrina-theme-masculine')
  assert.equal(themeColors('feminine').theme, THEME_COLORS.feminine.theme)
  assert.equal(themeColors('masculine').theme, THEME_COLORS.masculine.theme)
})

test('the feminine theme is a real CSS engine with soft colours, hover and large images', async () => {
  const css = await read('app/globals.css')
  const storefront = await read('components/store/Storefront.js')
  const header = await read('components/store/StoreHeader.js')
  const settings = await read('app/dashboard/_screens/settings.js')

  assert.match(css, /\.vetrina-theme-feminine\s*\{/)
  assert.match(css, /radial-gradient/)
  assert.match(css, /\.vetrina-theme-feminine \.sf-card:hover/)
  assert.match(css, /\.vetrina-theme-feminine \.sf-product-media/)
  assert.match(css, /aspect-ratio:\s*4 \/ 5/)
  assert.match(css, /transform:\s*scale\(1\.09\)/)
  assert.match(css, /prefers-reduced-motion/)
  assert.match(storefront, /resolveStoreTheme\(store\?\.store_type, store\?\.theme_key\)/)
  assert.match(storefront, /themeClass\(storeTheme\)/)
  assert.match(storefront, /data-store-theme=\{storeTheme\}/)
  assert.match(storefront, /sf-card/)
  assert.match(storefront, /sf-product-media/)
  assert.match(header, /sf-header/)
  assert.match(header, /sf-hero/)
  assert.match(header, /sf-logo/)
  assert.match(settings, /قالب المتجر الافتراضي/)
  assert.match(settings, /THEME_OPTIONS/)
  assert.match(settings, /CustomSelect/)
  assert.doesNotMatch(settings, /<select\b/i)
})

test('the masculine theme is a real storefront design with its own palette', async () => {
  const css = await read('app/globals.css')
  assert.match(css, /\.vetrina-theme-masculine\s*\{/)
  assert.match(css, /--background:\s*#17191D/)
  assert.match(css, /--card:\s*#1C2533/)
  assert.match(css, /--foreground:\s*#F4F2ED/)
  assert.match(css, /--gold:\s*#A88B61/)
  assert.match(css, /\.vetrina-theme-masculine \.sf-header/)
  assert.match(css, /\.vetrina-theme-masculine \.sf-hero/)
  assert.match(css, /\.vetrina-theme-masculine \.sf-card:hover/)
  assert.match(css, /\.vetrina-theme-masculine \.sf-product-media/)
  assert.match(css, /\.vetrina-theme-masculine \.sf-card-action/)
})

test('the masculine theme_key is accepted by the database and every writer RPC', async () => {
  const migration = await read('supabase/migrations/202611170003_masculine_theme_key.sql')
  assert.match(migration, /CHECK \(theme_key IN \('classic', 'feminine', 'masculine'\)\)/)
  assert.match(migration, /p_theme_key NOT IN \('classic', 'feminine', 'masculine'\)/)
  assert.match(migration, /p_theme_key NOT IN \('classic','feminine','masculine'\)/)
  // all three writers that validate the theme were updated
  assert.equal((migration.match(/p_theme_key NOT IN/g) || []).length, 3)
  assert.match(migration, /engine_update_store_settings/)
  assert.match(migration, /engine_set_branch_profile/)
  assert.match(migration, /engine_set_branch_specialty/)
  // the old two-value rule must not come back
  assert.doesNotMatch(migration, /theme_key IN \('classic', 'feminine'\)/)
  assert.doesNotMatch(migration, /theme_key NOT IN \('classic','feminine'\)/)
})
