import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { buildStoreManifest, cleanStoreName } from '../lib/pwa/manifest.js'
const read = path => fs.readFile(new URL(`../${path}`, import.meta.url), 'utf8')
test('store manifests brand each branch and never advertise the platform name', () => {
  for (const name of ['بوتيك الياسمين', 'Maison Lina']) {
    const manifest = buildStoreManifest({ slug: 'branch', store: { name } })
    assert.equal(manifest.name, name)
    assert.equal(manifest.short_name, name)
    assert.ok(manifest.description.includes(name))
    assert.ok(manifest.shortcuts[0].name.includes(name))
    assert.equal(manifest.start_url, '/s/branch')
    assert.doesNotMatch(JSON.stringify(manifest), /Vetrina/i)
  }
  assert.equal(cleanStoreName('  محل   التاجر  '), 'محل التاجر')
  assert.equal(cleanStoreName(null), 'المتجر')
})
test('server metadata and browser fallback both use live branch branding', async () => {
  const page = await read('app/s/[slug]/page.js')
  assert.match(page, /publicRpc\('get_store_by_slug'/)
  assert.match(page, /title: \{ absolute:/)
  assert.match(page, /applicationName: name/)
  assert.match(page, /title: name/)
  const pwa = await read('components/store/StorePwa.js')
  assert.match(pwa, /document.title = `\$\{name\}/)
  assert.match(pwa, /apple-mobile-web-app-title/)
  assert.match(pwa, /\[store\?\.name\]/)
  const prompt = await read('components/store/InstallPrompt.js')
  assert.match(prompt, /cleanStoreName\(store.name\)/)
  assert.match(prompt, /ثبّت متجر \{name\}/)
})
