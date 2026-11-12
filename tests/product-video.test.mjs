import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'

import { safeVideoUrl, videoPlatform, videoButtonLabel } from '../lib/video.js'

const read = path => fs.readFile(new URL(path, import.meta.url), 'utf8')
const strip = source => source
  .replace(/\s+/g, ' ')
  .replace(/ ?([,)])/g, '$1')
  .replace(/\( ?/g, '(')

const migration = await read('../supabase/migrations/202611120010_product_video_link.sql')
const products = await read('../app/dashboard/_screens/products.js')
const storefront = await read('../components/store/Storefront.js')
const productSheet = await read('../components/store/ProductSheet.js')

test('a shared link becomes a usable https URL', () => {
  assert.equal(safeVideoUrl('https://www.tiktok.com/@shop/video/123'), 'https://www.tiktok.com/@shop/video/123')
  // What the share sheet actually copies.
  assert.equal(safeVideoUrl('tiktok.com/@shop/video/1'), 'https://tiktok.com/@shop/video/1')
  assert.equal(safeVideoUrl('  https://www.instagram.com/reel/abc/  '), 'https://www.instagram.com/reel/abc/')
})

test('anything that is not a web link is refused', () => {
  assert.equal(safeVideoUrl('javascript:alert(1)'), '')
  assert.equal(safeVideoUrl('data:text/html,<script>alert(1)</script>'), '')
  assert.equal(safeVideoUrl('file:///etc/passwd'), '')
  assert.equal(safeVideoUrl(''), '')
  assert.equal(safeVideoUrl(null), '')
  assert.equal(safeVideoUrl('not a url'), '')
  // A bare host with no dot is not a site.
  assert.equal(safeVideoUrl('localhost'), '')
})

test('the platform is named when we can tell', () => {
  assert.deepEqual(videoPlatform('https://www.tiktok.com/@s/video/1'), { key: 'tiktok', label: 'تيك توك' })
  assert.equal(videoPlatform('https://vm.tiktok.com/x/').key, 'tiktok')
  assert.equal(videoPlatform('https://www.instagram.com/reel/abc/').label, 'إنستغرام')
  assert.equal(videoPlatform('https://web.facebook.com/watch/?v=1').label, 'فيسبوك')
  assert.equal(videoPlatform('https://fb.watch/abc/').label, 'فيسبوك')
  assert.equal(videoPlatform('https://youtu.be/abc').label, 'يوتيوب')
  // Unknown host, but still a real link.
  assert.equal(videoPlatform('https://example.com/v').key, 'other')
  assert.equal(videoPlatform('javascript:1').key, '')
})

test('the button names the platform it will open', () => {
  assert.equal(videoButtonLabel('https://www.tiktok.com/@s/video/1'), 'شاهد الفيديو على تيك توك')
  assert.equal(videoButtonLabel('https://www.instagram.com/reel/abc/'), 'شاهد الفيديو على إنستغرام')
  assert.equal(videoButtonLabel('https://example.com/v'), 'شاهد الفيديو')
  assert.equal(videoButtonLabel(''), 'شاهد الفيديو')
  assert.equal(videoButtonLabel('https://youtu.be/x', 'معاينة'), 'معاينة على يوتيوب')
})

// --- schema ------------------------------------------------------------

test('the column is nullable, text, and limited to http(s)', () => {
  const flat = strip(migration)
  assert.match(flat, /ALTER TABLE public\.products ADD COLUMN IF NOT EXISTS external_video_url text/)
  assert.match(flat, /CHECK ?\(external_video_url IS NULL OR external_video_url ~\* '\^https\?:\/\/\[\^\[:space:\]\]\+\$'\)/)
  // Applying it twice must be safe.
  assert.match(flat, /IF NOT EXISTS \(SELECT 1 FROM pg_constraint WHERE conname = 'products_external_video_url_http'\)/)
})

test('the public store actually receives the link', () => {
  const flat = strip(migration)
  assert.match(flat, /'external_video_url', CASE WHEN p\.external_video_url ~\* '\^https\?:\/\/\[\^\[:space:\]\]\+\$' THEN p\.external_video_url ELSE NULL END/)
  assert.match(flat, /GRANT EXECUTE ON FUNCTION public\.get_store_products\(uuid\) TO anon, authenticated/)
})

// --- dashboard form ----------------------------------------------------

test('the add form saves a valid link and refuses a broken one', () => {
  const flat = strip(products)
  assert.match(flat, /external_video_url: ''/)
  assert.match(flat, /const videoUrl = form\.external_video_url\.trim\(\) \? safeVideoUrl\(form\.external_video_url\) : ''/)
  assert.match(flat, /if ?\(form\.external_video_url\.trim\(\) && !videoUrl\)/)
  assert.match(flat, /external_video_url: videoUrl \|\| null/)
  assert.match(flat, /رابط فيديو المنتج \(تيك توك \/ إنستغرام \/ فيسبوك\)/)
})

test('an existing product can be given, changed or stripped of its video', () => {
  const flat = strip(products)
  assert.match(flat, /\.update\(\{ external_video_url: clean \|\| null \}\)\s*\.eq\('id', videoTarget\.id\)/)
  assert.match(flat, /function openVideoEditor\(product\)/)
  assert.match(flat, /onClick=\{\(\) => openVideoEditor\(p\)\}/)
  // Clearing the input then saving removes the link.
  assert.match(flat, /onClick=\{\(\) => setVideoValue\(''\)\}/)
})

// --- storefront --------------------------------------------------------

test('the card shows a video badge that opens a new tab', () => {
  const flat = strip(storefront)
  assert.match(flat, /const videoHref = safeVideoUrl\(product\.external_video_url\)/)
  assert.match(flat, /href=\{videoHref\} target="_blank" rel="noopener noreferrer"/)
  // The link sits above the overlay that opens the product.
  assert.match(flat, /className="absolute end-2 top-2 z-20/)
  assert.match(flat, /فيديو/)
})

test('the product modal offers a labelled button for the platform', () => {
  const flat = strip(productSheet)
  assert.match(flat, /const videoHref = safeVideoUrl\(product\?\.external_video_url\)/)
  assert.match(flat, /const videoLabel = videoButtonLabel\(videoHref, 'شاهد الفيديو'\)/)
  assert.match(flat, /\{videoLabel\}/)
  assert.match(flat, /target="_blank" rel="noopener noreferrer"/)
})
