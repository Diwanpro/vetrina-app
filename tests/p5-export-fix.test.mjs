import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'

const read = file => fs.readFile(new URL(`../${file}`, import.meta.url), 'utf8')
const { fallbackExportTemplates, enabledTemplateValues } = await import('../lib/shipping/export-options.js')
const { listProviders } = await import('../lib/shipping/registry.js')

test('the export drawer always has a registry-derived Yalidine + ZR template list', () => {
  const templates = fallbackExportTemplates({ storeId: 'store-1', storeName: 'فرع قسنطينة' })
  assert.equal(templates.length, listProviders().filter(provider => provider.capabilities.bulkTemplate).length)
  assert.equal(templates.length, 3)
  assert.ok(templates.every(template =>
    template.value.endsWith(':sandbox:store-1') && template.requiresConnection === true))
  assert.ok(templates.some(template => template.label.includes('يليدين')))
  assert.ok(templates.some(template => template.label.includes('ZR')))
  assert.deepEqual(fallbackExportTemplates({ storeId: '' }), [])
  assert.equal(enabledTemplateValues(templates).size, 3)
})

test('the CSV button is never disabled by an empty connection list', async () => {
  const exportButton = await read('components/dashboard/ShippingExportButton.js')
  const orders = await read('app/dashboard/_screens/orders.js')
  const options = await read('lib/shipping/export-options.js')
  const shippingIndex = await read('lib/shipping/index.js')

  assert.match(exportButton, /useDrawerMenu/)
  assert.match(exportButton, /drawerClass\(phase\)/)
  assert.match(exportButton, /createPortal/)
  assert.match(exportButton, /mounted && rect/)
  assert.match(exportButton, /setupHint/)
  assert.doesNotMatch(exportButton, /!hasTemplates/)
  assert.doesNotMatch(exportButton, /<select\b/i)
  assert.match(orders, /fallbackExportTemplates/)
  assert.match(orders, /enabledTemplateValues/)
  assert.match(orders, /exportMenuTemplates/)
  assert.match(orders, /setupHint=/)
  assert.doesNotMatch(orders, /disabled=\{!exportTemplates\.length\}/)
  assert.doesNotMatch(orders, /shippingTarget|CustomSelect|<select\b/i)

  // No courier code is hard-coded in the UI or the fallback helper.
  for (const source of [exportButton, orders, options]) {
    assert.doesNotMatch(source, /['"](?:yalidine|zrexpress|zrexpressnew)['"]/)
  }
  // P4 defect: event keys are derived from the selected provider, not Yalidine.
  assert.doesNotMatch(shippingIndex, /yalidine:/)
  assert.match(shippingIndex, /event_key: `\$\{code\}/)
})
