import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'

const read = file => fs.readFile(new URL(`../${file}`, import.meta.url), 'utf8')
const { createKeyboardWedgeBuffer } = await import('../lib/barcode/keyboard-wedge.js')
const { RECEIPT_WIDTH_OPTIONS, RECEIPT_TRANSPORT_OPTIONS, receiptHtml } = await import('../lib/printing/receipt.js')

// المرحلة 2: HID scanners and 58/80mm thermal printing through the browser.
test('HID / Keyboard-Wedge scanners fill search and add-product fields', async () => {
  const buffer = createKeyboardWedgeBuffer()
  let now = 1000
  for (const char of 'MOCKM0101') { buffer.key({ key: char }, now); now += 10 }
  assert.equal(buffer.key({ key: 'Enter' }, now).code, 'MOCKM0101')

  const pos = await read('app/dashboard/pos/page.js')
  const products = await read('app/dashboard/_screens/products.js')
  const listener = await read('components/dashboard/KeyboardWedgeListener.js')
  assert.match(pos, /KeyboardWedgeListener/)
  assert.match(pos, /data-barcode-input="pos-search"/)
  assert.match(products, /KeyboardWedgeListener/)
  assert.match(products, /data-barcode-input="products-search"/)
  assert.match(products, /data-barcode-input="product-barcode"/)
  assert.match(listener, /fillControlledInput/)
  assert.match(listener, /document\.querySelector\(selector\)/)
})

test('browser printing sizes 58mm and 80mm thermal pages and keeps Arabic', async () => {
  assert.deepEqual(RECEIPT_WIDTH_OPTIONS.map(option => option.value), ['58mm', '80mm'])
  assert.equal(RECEIPT_TRANSPORT_OPTIONS[0].value, 'browser')
  for (const width of ['58mm', '80mm']) {
    const html = receiptHtml({
      width,
      store: { name: 'بوتيك النور' },
      items: [{ name: 'قفطان جزائري', qty: 1, unitPrice: 7500, lineTotal: 7500 }],
      total: 7500, paid: 7500,
    })
    assert.match(html, new RegExp(`@page \\{ size: ${width} auto`))
    assert.match(html, /lang="ar" dir="rtl"/)
    assert.match(html, /قفطان جزائري/)
  }

  const printer = await read('components/dashboard/ReceiptPrinter.js')
  const transports = await read('lib/printing/transports.js')
  assert.match(printer, /printViaBrowser/)
  assert.match(printer, /RECEIPT_WIDTH_OPTIONS/)
  assert.match(printer, /RECEIPT_TRANSPORT_OPTIONS/)
  assert.match(printer, /CustomSelect/)
  assert.match(transports, /iframe\.srcdoc = receiptHtml\(receipt\)/)
  assert.match(transports, /iframe\.contentWindow\?\.print\(\)/)
  assert.match(transports, /navigator\.usb/)
  assert.match(transports, /navigator\.bluetooth/)
  for (const source of [printer, transports]) assert.doesNotMatch(source, /<select\b/i)
})
