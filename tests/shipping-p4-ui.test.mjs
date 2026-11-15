import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))

async function read(relative) {
  return fs.readFile(path.join(ROOT, relative), 'utf8')
}

async function jsFiles(dir) {
  const entries = await fs.readdir(path.join(ROOT, dir), { withFileTypes: true })
  const files = []
  for (const entry of entries) {
    const relative = path.join(dir, entry.name)
    if (entry.isDirectory()) files.push(...await jsFiles(relative))
    else if (entry.name.endsWith('.js')) files.push(relative)
  }
  return files
}

test('P4 shipping menus use the shared «الدرج المنزلق» drawer', async () => {
  const shippingButton = await read('components/dashboard/ShippingButton.js')
  const exportButton = await read('components/dashboard/ShippingExportButton.js')
  const drawerMenu = await read('components/ui/drawerMenu.js')
  const css = await read('app/globals.css')

  for (const source of [shippingButton, exportButton]) {
    assert.match(source, /useDrawerMenu/)
    assert.match(source, /drawerClass\(phase\)/)
    assert.match(source, /createPortal/)
    assert.match(source, /role="listbox"/)
    assert.match(source, /role="option"/)
    assert.match(source, /Escape/)
    assert.doesNotMatch(source, /<select\b/i)
  }
  assert.match(exportButton, /تصدير الشحنات \(CSV\)/)
  assert.match(shippingButton, /شحن الطلب/)
  assert.match(drawerMenu, /240|180/)
  assert.match(css, /@keyframes vetrina-drawer-open/)
  assert.match(css, /@keyframes vetrina-drawer-close/)
  assert.match(css, /\.vetrina-drawer--open/)
  assert.match(css, /\.vetrina-drawer--closing/)
})

test('OrderCard options and CSV templates are derived from enabled connections', async () => {
  const orders = await read('app/dashboard/_screens/orders.js')
  const shippingButton = await read('components/dashboard/ShippingButton.js')
  const exportButton = await read('components/dashboard/ShippingExportButton.js')

  assert.match(orders, /shippingOptionsFor\s*=\s*useCallback/)
  assert.match(orders, /shippingConnections\s*[\s\S]{0,240}?\.filter\(row => row\.store_id === storeId/)
  assert.match(orders, /row\.enabled/)
  assert.match(orders, /\['api', 'both'\]\.includes\(row\.mode\)/)
  assert.match(orders, /capabilities\?\.create/)
  assert.match(orders, /exportTemplates\s*=\s*useMemo/)
  assert.match(orders, /\['bulk', 'both'\]\.includes\(row\.mode\)/)
  assert.match(orders, /capabilities\?\.bulkTemplate/)
  assert.match(orders, /ShippingExportButton/)
  assert.match(orders, /\/api\/shipping\/exports/)
  assert.match(orders, /new Blob\(\[body\.csv\]/)
  assert.match(orders, /shippingOptions=\{shippingOptionsFor\(order\.store_id/)
  assert.doesNotMatch(orders, /shippingTarget|CustomSelect|<select\b/i)
  assert.match(shippingButton, /options\.map\(option =>/)
  assert.match(shippingButton, /onShip\(order, option\.value\)/)
  assert.match(exportButton, /templates\.map\(template =>/)
  assert.match(exportButton, /onExport\(template\.value\)/)
  // No courier-specific branch leaked into the UI components.
  for (const source of [orders, shippingButton, exportButton]) {
    assert.doesNotMatch(source, /['"](?:yalidine|zrexpress|zrexpressnew)['"]/)
  }
})

test('settings activate all three couriers with the three approved modes', async () => {
  const settings = await read('components/dashboard/ShippingSettings.js')
  assert.match(settings, /listProviders\(\)\.map\(provider =>/)
  assert.match(settings, /وضع التصدير بالجملة CSV/)
  assert.match(settings, /الربط المباشر API/)
  assert.match(settings, /كلاهما/)
  assert.match(settings, /تفعيل الربط/)
  assert.match(settings, /form\.mode !== 'bulk'/)
  assert.match(settings, /CustomSelect/)
  assert.match(settings, /SearchableSelect/)
  assert.doesNotMatch(settings, /<select\b/i)
})

test('no native select remains in dashboard JSX', async () => {
  const files = [...await jsFiles('app'), ...await jsFiles('components')]
  assert.ok(files.length > 20)
  for (const file of files) {
    const source = await fs.readFile(path.join(ROOT, file), 'utf8')
    assert.doesNotMatch(source, /<select\b/i, `${file} still contains a native <select>`)
  }
})
