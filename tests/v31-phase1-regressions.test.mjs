import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'

const read = file => fs.readFile(new URL(`../${file}`, import.meta.url), 'utf8')

// المرحلة 1: regression checks for the two P4 defects the merchant saw.
test('CSV export still opens the same dark sliding drawer', async () => {
  const button = await read('components/dashboard/ShippingExportButton.js')
  const orders = await read('app/dashboard/_screens/orders.js')
  const css = await read('app/globals.css')

  assert.match(button, /useDrawerMenu/)
  assert.match(button, /drawerClass\(phase\)/)
  assert.match(button, /createPortal/)
  assert.match(button, /mounted && rect/)
  assert.match(button, /setupHint/)
  assert.match(button, /aria-haspopup="listbox"/)
  assert.doesNotMatch(button, /!hasTemplates/)
  assert.doesNotMatch(button, /<select\b/i)
  assert.match(css, /\.vetrina-drawer--open\s*\{/)
  assert.match(css, /animation:\s*vetrina-drawer-open/)
  assert.match(orders, /<ShippingExportButton/)
  assert.match(orders, /fallbackExportTemplates/)
  assert.match(orders, /enabledTemplateValues/)
  assert.match(orders, /setupHint=/)
})

test('order details still show product thumbnails beside customer data', async () => {
  const orders = await read('app/dashboard/_screens/orders.js')
  const notice = await read('components/dashboard/NewOrderNotice.js')
  const helper = await read('lib/orders.js')
  const migration = await read('supabase/migrations/202611120018_store_type_and_order_media.sql')

  assert.match(orders, /NewOrderNotice/)
  assert.match(orders, /ItemThumb key=\{item\.id\} item=\{item\} size="lg"/)
  assert.match(orders, /detail\.customer_phone/)
  assert.match(orders, /detail\.address/)
  assert.match(notice, /orderItemImage/)
  assert.match(notice, /<img key=/)
  assert.match(notice, /role="status"/)
  assert.match(helper, /image_url/)
  assert.match(migration, /CREATE TRIGGER trg_order_item_image/)
})

test('no native select was reintroduced in dashboard JSX', async () => {
  const files = [
    'app/dashboard/_screens/orders.js',
    'app/dashboard/_screens/settings.js',
    'app/dashboard/_screens/products.js',
    'app/dashboard/pos/page.js',
    'app/signup/page.js',
    'components/dashboard/ShippingExportButton.js',
    'components/dashboard/ReceiptPrinter.js',
    'components/dashboard/BranchProfileEditor.js',
  ]
  for (const file of files) {
    assert.doesNotMatch(await read(file), /<select\b/i, `${file} contains a native <select>`)
  }
})
