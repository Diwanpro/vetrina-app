import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const read = p => fs.readFile(path.join(ROOT, p), 'utf8')

const home = await read('app/page.js')

test('the root never renders the public store', async () => {
  // / is a router. A shop lives at /s/<slug>, and a visitor who opens the bare
  // domain must not land in somebody else's shop.
  assert.doesNotMatch(home, /from '@\/components\/store/, 'the root must not mount a storefront')
  assert.doesNotMatch(home, /Storefront/)
  assert.doesNotMatch(home, /\/s\/\$\{/, 'the root must not build a /s/<slug> URL')
  // The storefront lives at app/s/[slug] and stays there; the point is only
  // that the root does not reach into it.
  const segments = await fs.readdir(path.join(ROOT, 'app'))
  assert.ok(segments.includes('s'), 'sanity: the storefront segment still exists')
  assert.ok(segments.includes('page.js'), 'sanity: the root page still exists')
})

test('the root sends a session to the dashboard and everyone else to login', () => {
  assert.match(home, /data\?\.session \? '\/dashboard' : '\/login'/)
  // replace(), not push(): the back button must not return to a page that
  // immediately bounces again.
  assert.doesNotMatch(home, /router\.push\(/)
})

test('an unreachable auth check still lands on login, never on the store', () => {
  assert.match(home, /\.catch\(\(\) => go\('\/login'\)\)/)
  // An offline cashier keeps the POS instead of being bounced to login.
  assert.match(home, /localStorage\.getItem\('vetrina\.auth'\)[\s\S]*?go\('\/dashboard\/pos'\)/)
})

test('no rewrite sends the root to a store slug', async () => {
  const config = await read('next.config.js')
  assert.doesNotMatch(config, /source: '\/'/, 'the root is not rewritten by config')
  assert.doesNotMatch(config, /destination: '\/s\//, 'nothing redirects to a storefront')
})
