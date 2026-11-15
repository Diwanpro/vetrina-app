import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'

const read = file => fs.readFile(new URL(`../${file}`, import.meta.url), 'utf8')
const { ORDER_ITEM_FIELDS, orderItemImage } = await import('../lib/orders.js')

test('the order line snapshot wins, then the embedded product falls back', () => {
  assert.equal(orderItemImage({ image_url: 'snapshot.jpg', products: { images: ['a.jpg'] } }), 'snapshot.jpg')
  assert.equal(orderItemImage({ image_url: '  ', products: { images: ['a.jpg'], image_url: 'b.jpg' } }), 'a.jpg')
  assert.equal(orderItemImage({ products: { images: [], image_url: 'b.jpg' } }), 'b.jpg')
  assert.equal(orderItemImage({ products: { images: ['  '], image_url: 'real.jpg' } }), 'real.jpg')
  assert.equal(orderItemImage({ products: null }), '')
  assert.equal(orderItemImage({ image_url: 'only-snapshot.jpg', products: null }), 'only-snapshot.jpg')
})

test('the orders query asks for the image_url snapshot and product_id', () => {
  for (const column of ['product_id', 'image_url', 'product_name', 'size', 'color', 'qty', 'unit_price', 'line_total']) {
    assert.ok(ORDER_ITEM_FIELDS.includes(column), `${column} must be selected`)
  }
  assert.match(ORDER_ITEM_FIELDS, /products\(name, images, image_url\)/)
})

test('migration 018 snapshots images without touching public.orders', async () => {
  const sql = await read('supabase/migrations/202611120018_store_type_and_order_media.sql')
  assert.match(sql, /ALTER TABLE public\.order_items ADD COLUMN IF NOT EXISTS image_url text/)
  assert.match(sql, /CREATE TRIGGER trg_order_item_image/)
  assert.match(sql, /BEFORE INSERT ON public\.order_items/)
  assert.match(sql, /UPDATE public\.order_items oi[\s\S]*?SET image_url = src\.image_url/)
  assert.match(sql, /REVOKE ALL ON FUNCTION public\.order_item_image_default\(\) FROM PUBLIC, anon, authenticated/)
  for (const forbidden of [
    /ALTER\s+TABLE\s+public\.orders\b/i,
    /UPDATE\s+public\.orders\b/i,
    /INSERT\s+INTO\s+public\.orders\b/i,
    /DELETE\s+FROM\s+public\.orders\b/i,
  ]) assert.doesNotMatch(sql, forbidden)
})

test('the new-order notification and detail modal draw thumbnails beside customer data', async () => {
  const screen = await read('app/dashboard/_screens/orders.js')
  const notice = await read('components/dashboard/NewOrderNotice.js')
  assert.match(screen, /NewOrderNotice/)
  assert.match(screen, /setInterval\(\(\) => \{ load\(\) \}, 30000\)/)
  assert.match(screen, /تفاصيل الطلب الجديد/)
  assert.match(screen, /ItemThumb key=\{item\.id\} item=\{item\} size="lg"/)
  assert.match(screen, /detail\.customer_phone/)
  assert.match(screen, /detail\.address/)
  assert.match(notice, /orderItemImage/)
  assert.match(notice, /role="status"/)
  assert.match(notice, /Notification\.permission/)
  assert.match(notice, /عرض تفاصيل الطلب والصور/)
  assert.doesNotMatch(notice, /<select\b/i)
})
