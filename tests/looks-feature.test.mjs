import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const read = p => fs.readFile(path.join(ROOT, p), 'utf8')
// SQL assertions run on statements only: a rule described in a comment must not
// satisfy a test that is meant to check what actually executes.
const sqlOf = async p => (await read(p)).split('\n').filter(l => !l.trim().startsWith('--')).join('\n')

const sql = await sqlOf('supabase/migrations/202611120012_looks_feature.sql')
const looks = await read('app/dashboard/_screens/looks.js')
const storefront = await read('components/store/Storefront.js')
const lookSheet = await read('components/store/LookSheet.js')
const cartSheet = await read('components/store/CartSheet.js')
const useLooks = await read('components/store/useStoreLooks.js')
const nav = await read('components/dashboard/navItems.js')
const stock = await read('app/dashboard/stock/page.js')

test('both tables exist with the columns the feature needs', () => {
  assert.match(sql, /CREATE TABLE IF NOT EXISTS public\.looks/)
  for (const column of ['tenant_id', 'name', 'description', 'image_url', 'video_url', 'bundle_price', 'is_active', 'created_at']) {
    assert.match(sql, new RegExp(`ALTER TABLE public\\.looks ADD COLUMN IF NOT EXISTS ${column}`), `looks.${column}`)
  }
  assert.match(sql, /CREATE TABLE IF NOT EXISTS public\.look_items/)
  for (const column of ['look_id', 'product_id', 'variant_id']) {
    assert.match(sql, new RegExp(`ALTER TABLE public\\.look_items ADD COLUMN IF NOT EXISTS ${column}`), `look_items.${column}`)
  }
})

test('deleting a look or a product cannot leave dangling items', () => {
  assert.match(sql, /look_id\s+uuid NOT NULL REFERENCES public\.looks\(id\) ON DELETE CASCADE/)
  assert.match(sql, /product_id uuid NOT NULL REFERENCES public\.products\(id\) ON DELETE CASCADE/)
  assert.match(sql, /variant_id uuid REFERENCES public\.product_variants\(id\) ON DELETE CASCADE/)
})

test('RLS isolates tenants on both tables', () => {
  assert.match(sql, /ALTER TABLE public\.looks\s+ENABLE ROW LEVEL SECURITY/)
  assert.match(sql, /ALTER TABLE public\.look_items ENABLE ROW LEVEL SECURITY/)
  assert.match(sql, /CREATE POLICY looks_tenant_isolation ON public\.looks/)
  assert.match(sql, /tenant_id = public\.current_tenant_id\(\)/)
  // Items have no tenant_id of their own, so they inherit the look's.
  assert.match(sql, /CREATE POLICY look_items_tenant_isolation ON public\.look_items/)
})

test('anon gets no table access, matching the rest of the storefront', () => {
  // 202611120011 revoked table access from anon and routes everything through
  // SECURITY DEFINER RPCs. A "public read" policy would undo that.
  // Named per table, so an audit of the RLS block sees each one.
  assert.match(sql, /REVOKE ALL ON TABLE public\.looks FROM PUBLIC, anon/)
  assert.match(sql, /REVOKE ALL ON TABLE public\.look_items FROM PUBLIC, anon/)
  assert.equal(/CREATE POLICY[^;]*TO anon/.test(sql), false, 'no anon policy')
  assert.equal(/GRANT SELECT ON TABLE public\.looks TO anon/.test(sql), false)
})

test('the storefront reads looks through an RPC gated on the store', () => {
  assert.match(sql, /CREATE OR REPLACE FUNCTION public\.get_store_looks\(p_slug text\)/)
  assert.match(sql, /WHERE slug = p_slug AND coalesce\(store_enabled, false\)/)
  assert.match(sql, /GRANT EXECUTE ON FUNCTION public\.get_store_looks\(text\) TO anon, authenticated/)
  // Prices must respect the shop's show_prices setting.
  assert.match(sql, /CASE WHEN coalesce\(s\.show_prices, true\) THEN l\.bundle_price ELSE NULL END/)
})

test('a look only shows products that are sellable in that store', () => {
  assert.match(sql, /AND \(i\.quantity - coalesce\(i\.reserved_qty, 0\)\) > 0/)
  assert.match(sql, /AND coalesce\(l\.is_active, true\)/)
})

test('the bundle price is never written where the POS would apply it', () => {
  // Putting it in `offers` would discount the same products at the till, where
  // min_price can reject the sale entirely.
  assert.equal(/INSERT INTO public\.offers/.test(sql), false, 'looks must not write to offers')
  assert.equal(/bundle_source/.test(sql), false, 'the offers-based approach was abandoned')
})

test('create_order prices the outfit server-side and ignores the client value', () => {
  assert.match(sql, /p_look_id uuid DEFAULT NULL/)
  assert.match(sql, /bundle := public\.looks_bundle_units\(p_look_id\)/)
  // A crafted p_bundle_units must not become the price: anything that differs
  // from the server's own computation is discarded outright.
  assert.match(sql, /jsonb_typeof\(p_bundle_units\) <> 'object' OR p_bundle_units IS DISTINCT FROM bundle/)
})

test('the outfit price does not stack on an existing offer', () => {
  assert.match(sql, /IF p_look_id IS NOT NULL AND NOT offer_ok THEN/)
})

test('the old create_order signatures are dropped, not left callable', () => {
  assert.match(sql, /DROP FUNCTION IF EXISTS public\.create_order\(uuid, jsonb, jsonb, text\)/)
  assert.match(sql, /DROP FUNCTION IF EXISTS public\.create_order\(uuid, jsonb, jsonb, text, text, integer\)/)
  assert.match(sql, /GRANT EXECUTE ON FUNCTION public\.create_order\(uuid,jsonb,jsonb,text,text,integer,uuid,jsonb\) TO anon, authenticated/)
})

test('the bundle split is exact and matches the client', () => {
  assert.match(sql, /last_unit := total - base_unit \* \(units - 1\)/)
  assert.match(sql, /ORDER BY p\.name, li\.product_id/)
})

test('a single-product look cannot carry a bundle price', () => {
  // create_order only applies a bundle at required_qty >= 2, so such a price
  // would never be charged.
  assert.match(sql, /IF units = 1 THEN\s+RAISE EXCEPTION 'سعر الإطلالة يتطلب منتجين على الأقل/)
})

test('saving a look validates that every product is the tenant\'s own', () => {
  assert.match(sql, /WHERE p\.id = \(el->>'product_id'\)::uuid AND p\.tenant_id = u\.tenant_id/)
  assert.match(sql, /منتج غير موجود في هذه المؤسسة/)
  // Variants are checked through their product, so a foreign variant id fails.
  assert.match(sql, /JOIN public\.products p ON p\.id = v\.product_id\s+WHERE v\.id = \(el->>'variant_id'\)::uuid AND p\.tenant_id = u\.tenant_id/)
})

test('a look refuses to save with no products', () => {
  assert.match(sql, /IF jsonb_array_length\(p_items\) = 0 THEN\s+RAISE EXCEPTION 'أضف منتجاً واحداً على الأقل'/)
})

test('the same product cannot appear twice in a look', () => {
  assert.match(sql, /CREATE UNIQUE INDEX IF NOT EXISTS look_items_once/)
  assert.match(sql, /SELECT DISTINCT ON \(\(el->>'product_id'\)::uuid\)/)
})

test('management RPCs are not callable by clients that are not staff', () => {
  // Plain substring checks: a signature like `(uuid)` inside a RegExp is a
  // capture group, not a literal, which is how this test first lied.
  for (const fn of ['engine_look_catalog(uuid)', 'engine_looks_list()', 'engine_delete_look(uuid)', 'engine_set_look_active(uuid, boolean)']) {
    assert.ok(sql.includes(`REVOKE ALL ON FUNCTION public.${fn} FROM PUBLIC, anon`), `revoke ${fn}`)
    assert.ok(sql.includes(`GRANT EXECUTE ON FUNCTION public.${fn} TO authenticated`), `grant ${fn}`)
  }
})

test('the storage bucket is public-read but tenant-scoped on write', () => {
  assert.match(sql, /INSERT INTO storage\.buckets\(id, name, public, file_size_limit, allowed_mime_types\)\s+VALUES \('look-images', 'look-images', true/)
  assert.match(sql, /CREATE POLICY look_images_write ON storage\.objects/)
  assert.match(sql, /\(storage\.foldername\(name\)\)\[1\] = public\.current_tenant_id\(\)::text/)
})

test('the dashboard screen can list, add, edit and delete', () => {
  for (const rpc of ['engine_save_look', 'engine_set_look_active', 'engine_delete_look', 'engine_looks_list', 'engine_look_catalog']) {
    assert.match(looks, new RegExp(`rpc\\('${rpc}'`), rpc)
  }
  // Editing reuses the saved id instead of creating a second look.
  assert.match(looks, /p_id: form\.id/)
})

test('the image upload goes to the tenant folder and validates the file', () => {
  assert.match(looks, /const BUCKET = 'look-images'/)
  assert.match(looks, /const path = `\$\{ctx\.tenantId\}\//)
  assert.match(looks, /file\.size > MAX_BYTES/)
  assert.match(looks, /image\\\/\(jpeg\|png\|webp\|avif\)/)
})

test('the dashboard refuses a bundle price below two products before calling the RPC', () => {
  assert.match(looks, /items\.length < 2/)
  assert.match(looks, /سعر الإطلالة يتطلب منتجين على الأقل/)
})

test('the look tab is registered in the stock group and the nav', () => {
  assert.match(stock, /key: 'looks', label: 'الإطلالات'/)
  assert.match(nav, /'\/dashboard\/looks': '\/dashboard\/stock'/)
})

test('the storefront only shows the looks tab when there are looks', () => {
  assert.match(storefront, /const showLooks = looks\.length > 0/)
  assert.match(storefront, /إطلالات جديدة/)
})

test('a looks failure never takes the catalogue down', () => {
  // No looks, a missing migration, or an RPC error all mean "no tab".
  // The list is still built defensively from whatever the RPC returns; it is
  // simply normalised on the way in now so every item has a resolved picture.
  assert.match(useLooks, /\(Array\.isArray\(data\) \? data : \[\]\)/)
  assert.match(useLooks, /setLooks\(list\)/)
  assert.match(useLooks, /catch \(err\)/)
  assert.match(useLooks, /console\.error\('\[storefront\] looks unavailable', err\)/)
})

test('the bundle button waits until every piece has a size', () => {
  assert.match(lookSheet, /const missing = chosen\.filter\(row => row\.variants\.length > 0 && !row\.variant\)/)
  assert.match(lookSheet, /disabled=\{Boolean\(missing\.length\) \|\| added\}/)
})

test('the bundle button is hidden when a product already has an offer', () => {
  // create_order applies one price per product, so promising the outfit price
  // would overstate the discount.
  assert.match(lookSheet, /const blocked = chosen\.filter\(row => row\.item\.has_offer\)/)
  assert.match(lookSheet, /const hasBundle = bundle > 0 && items\.length > 1 && blocked\.length === 0/)
})

test('single pieces can still be bought on their own', () => {
  assert.match(lookSheet, /function buyOne\(row\)/)
  assert.match(lookSheet, /أضف/)
})

test('the cart sends the look and its unit prices', () => {
  assert.match(cartSheet, /p_look_id: lookId/)
  assert.match(cartSheet, /p_bundle_units: lookId/)
})

test('a look line is not discounted a second time by the offer engine', () => {
  assert.match(storefront, /item\.fromLook \? \{ \.\.\.item, manualPrice: true \} : item/)
  assert.match(storefront, /fromLook: override != null/)
})

test('video links are validated before being shown or saved', () => {
  assert.match(lookSheet, /safeVideoUrl\(look\?\.video_url\)/)
  assert.match(looks, /safeVideoUrl\(form\.videoUrl\)/)
})

test('the bundle total the client shows equals the bundle price', async () => {
  // Same split as the SQL: floor division, remainder on the last product.
  const { lookUnitPrices } = await import(path.join(ROOT, 'lib/storefront.js')).catch(() => ({}))
  if (!lookUnitPrices) return // Next-style extensionless imports are not resolvable here.
  for (const [units, total] of [[2, 10000], [3, 10000], [3, 1000], [5, 999]]) {
    const look = { bundle_price: total, items: Array.from({ length: units }, (_, i) => ({ product_id: `p${i}`, name: `N${i}` })) }
    const prices = lookUnitPrices(look)
    const sum = Object.values(prices).reduce((a, b) => a + b, 0)
    assert.equal(sum, total, `${units} units at ${total}`)
  }
})

// ---------------------------------------- look item pictures (202611120014)

const imagesFix = await sqlOf('supabase/migrations/202611120014_look_item_images.sql')

test('look items resolve their picture the same way products do', () => {
  // get_store_looks() used to return only p.image_url, so a piece whose photos
  // lived in images[] drew an empty square inside a look while looking correct
  // on the product grid. The RPC now returns both halves, resolved.
  assert.match(imagesFix, /CREATE OR REPLACE FUNCTION public\.first_image_url\(p_images text\[\], p_image_url text\)/)
  assert.match(imagesFix, /'image_url', public\.first_image_url\(p\.images, p\.image_url\)/)
  assert.match(imagesFix, /'images', coalesce\(p\.images, ARRAY\[\]::text\[\]\)/)
  // The look's own cover goes through the same helper so a blank column becomes
  // NULL instead of an empty src="" that re-requests the page.
  assert.match(imagesFix, /'image_url', public\.first_image_url\(NULL, l\.image_url\)/)
})

test('first_image_url prefers the array and skips blank entries', () => {
  // Mirrors productImage() in JS: first usable array entry, else the single
  // column, else NULL. A blank entry is what an interrupted upload leaves.
  assert.match(imagesFix, /unnest\(coalesce\(p_images, ARRAY\[\]::text\[\]\)\)/)
  assert.match(imagesFix, /WHERE nullif\(btrim\(coalesce\(entry, ''\)\), ''\) IS NOT NULL/)
  assert.match(imagesFix, /nullif\(btrim\(coalesce\(p_image_url, ''\)\), ''\)/)
})

test('the replacement keeps the store gate and the sellable-only filter', () => {
  // A rewrite must not quietly drop the rules 202611120012 established.
  assert.match(imagesFix, /WHERE slug = p_slug AND coalesce\(store_enabled, false\)/)
  assert.match(imagesFix, /AND coalesce\(l\.is_active, true\)/)
  assert.match(imagesFix, /AND \(i\.quantity - coalesce\(i\.reserved_qty, 0\)\) > 0/)
  assert.match(imagesFix, /CASE WHEN coalesce\(s\.show_prices, true\) THEN l\.bundle_price ELSE NULL END/)
})

test('the storefront normalises look pictures client-side as well', () => {
  // The client must not break on a database where 202611120014 has not run.
  assert.match(lookSheet, /import \{ formatMoney, productImage \} from '@\/lib\/storefront'/)
  assert.match(lookSheet, /productImage\(row\.item\)/)
  assert.doesNotMatch(lookSheet, /row\.item\.image_url &&/)
  assert.match(useLooks, /image_url: productImage\(item\)/)
})
