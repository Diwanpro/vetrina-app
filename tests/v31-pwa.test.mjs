import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'

const read = file => fs.readFile(new URL(`../${file}`, import.meta.url), 'utf8')
const { buildStoreManifest, safeStoreIcon, normalizeSlug } = await import('../lib/pwa/manifest.js')
const { manifestHref, urlBase64ToUint8Array } = await import('../lib/pwa/client.js')

// المرحلة 5: installable store with a dynamic per-branch manifest.
test('the manifest takes its name, logo, start URL and colours from the branch', () => {
  const manifest = buildStoreManifest({
    slug: 'myshop',
    store: {
      name: 'بوتيك النور', slug: 'myshop',
      logo_url: 'https://cdn.example.com/logo.png',
      store_type: 'womens', theme_key: 'classic',
    },
    theme: 'feminine',
  })
  assert.equal(manifest.name, 'بوتيك النور')
  assert.equal(manifest.short_name, 'بوتيك النور')
  assert.equal(manifest.start_url, '/s/myshop')
  assert.equal(manifest.id, '/s/myshop')
  assert.equal(manifest.icons[0].src, 'https://cdn.example.com/logo.png')
  assert.equal(manifest.theme_color, '#3a2130')
  assert.equal(manifest.display, 'standalone')
  assert.equal(manifest.dir, 'rtl')
  assert.equal(manifestHref('myshop'), '/api/store/myshop/manifest')
  assert.equal(normalizeSlug('../evil'), '..-evil')
  assert.equal(safeStoreIcon('javascript:alert(1)'), '')
  assert.equal(safeStoreIcon('//evil.example/logo.png'), '')
  assert.equal(safeStoreIcon('/logo.png'), '/logo.png')

  const unsafe = buildStoreManifest({ slug: 'x', store: { logo_url: 'javascript:alert(1)' } })
  assert.doesNotMatch(JSON.stringify(unsafe), /javascript:/)
  assert.ok(unsafe.icons.some(icon => icon.src === '/icon-192.png'))
})

test('the VAPID public key decodes into browser PushManager bytes', () => {
  const key = 'A'.repeat(87)
  assert.equal(urlBase64ToUint8Array(key).length, 65)
  assert.ok(urlBase64ToUint8Array(key) instanceof Uint8Array)
})

test('dynamic manifest route, service worker and install UI are wired', async () => {
  const route = await read('app/api/store/[slug]/manifest/route.js')
  const page = await read('app/s/[slug]/page.js')
  const worker = await read('public/service-worker.js')
  const shim = await read('public/sw.js')
  const session = await read('components/dashboard/SessionProvider.js')
  const storefront = await read('components/store/Storefront.js')
  const storePwa = await read('components/store/StorePwa.js')
  const install = await read('components/store/InstallPrompt.js')
  const push = await read('components/store/PushOptIn.js')
  const staticManifest = JSON.parse(await read('public/manifest.json'))

  assert.match(route, /publicRpc\('get_store_by_slug'/)
  assert.match(route, /buildStoreManifest/)
  assert.match(route, /resolveStoreTheme/)
  assert.match(route, /application\/manifest\+json/)
  assert.match(page, /manifestHref\(safeSlug\)/)
  assert.match(page, /manifest,/)

  assert.match(worker, /self\.addEventListener\('push'/)
  assert.match(worker, /showNotification\(title, options\)/)
  assert.match(worker, /self\.addEventListener\('notificationclick'/)
  assert.match(worker, /pushsubscriptionchange/)
  assert.match(worker, /\/api\//)
  assert.match(shim, /importScripts\('\/service-worker\.js'\)/)
  assert.match(session, /register\('\/service-worker\.js', \{ scope: '\/' \}\)/)
  assert.equal(staticManifest.id, '/dashboard/pos')

  assert.match(storefront, /<StorePwa slug=\{slug\} store=\{store\} \/>/)
  assert.match(storePwa, /link\[rel="manifest"\]/)
  assert.match(storePwa, /manifestHref\(slug\)/)
  assert.match(storePwa, /register\('\/service-worker\.js'/)
  assert.match(install, /beforeinstallprompt/)
  assert.match(install, /deferred\.current\.prompt\(\)/)
  assert.match(install, /isIosSafari/)
  assert.match(install, /تثبيت الآن/)
  assert.match(push, /Notification\.requestPermission/)
  assert.match(push, /\/api\/push\/public-key/)
  assert.match(push, /\/api\/push\/subscribe/)
  for (const source of [storePwa, install, push]) assert.doesNotMatch(source, /<select\b/i)
})
