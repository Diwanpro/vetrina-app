import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'

const read = file => fs.readFile(new URL(`../${file}`, import.meta.url), 'utf8')
const { createKeyboardWedgeBuffer, normalizeBarcode, WEDGE_DEFAULTS } = await import('../lib/barcode/keyboard-wedge.js')
const {
  RECEIPT_WIDTHS, normalizeReceipt, receiptLines, receiptHtml, formatDzd, latinFallback,
  RECEIPT_TRANSPORT_OPTIONS,
} = await import('../lib/printing/receipt.js')
const { buildEscPosBytes, ESC_POS } = await import('../lib/printing/escpos.js')
const { canUseWebUsb, canUseWebBluetooth, BLUETOOTH_PRINT_SERVICES } = await import('../lib/printing/transports.js')

test('HID / Keyboard-Wedge scanners are recognised by fast keystrokes and Enter', () => {
  const buffer = createKeyboardWedgeBuffer()
  let now = 1000
  for (const char of 'MOCKM0101') {
    assert.equal(buffer.key({ key: char }, now).handled, false)
    now += 10
  }
  const result = buffer.key({ key: 'Enter' }, now)
  assert.equal(result.handled, true)
  assert.equal(result.code, 'MOCKM0101')
})

test('normal typing, modifiers and short codes are never hijacked', () => {
  assert.equal(normalizeBarcode('  MOCKM0101\r\n'), 'MOCKM0101')
  const slow = createKeyboardWedgeBuffer()
  let now = 1000
  for (const char of 'MOCKM0101') { slow.key({ key: char }, now); now += 100 }
  assert.equal(slow.key({ key: 'Enter' }, now).handled, false)

  const short = createKeyboardWedgeBuffer()
  for (const char of 'ABC123') short.key({ key: char }, 1000)
  assert.equal(short.key({ key: 'Enter' }, 1100).handled, false)

  const modified = createKeyboardWedgeBuffer()
  for (const char of 'MOCKM0101') modified.key({ key: char, ctrlKey: true }, 1000)
  assert.equal(modified.key({ key: 'Enter' }, 1100).handled, false)
  assert.equal(WEDGE_DEFAULTS.minLength, 8)
})

test('a scanner without an Enter suffix still flushes after the key gap', () => {
  const buffer = createKeyboardWedgeBuffer()
  for (const char of 'MOCKW0101') buffer.key({ key: char }, 1000)
  const result = buffer.flush(1150)
  assert.equal(result.handled, true)
  assert.equal(result.code, 'MOCKW0101')
})

test('ESC/POS bytes support 58mm and 80mm and end with a cut command', () => {
  assert.deepEqual(RECEIPT_WIDTHS.map(width => width.value), ['58mm', '80mm'])
  const receipt = normalizeReceipt({
    width: '58mm',
    number: 'POS-1',
    store: { name: 'محل النور', phone: '0555123456' },
    items: [
      { name: '<script>فساتين</script>', qty: 2, unitPrice: 3000, lineTotal: 6000 },
      { name: 'كعب عالي', qty: 1, unitPrice: 4000, lineTotal: 4000 },
    ],
    total: 10000, paid: 10000, credit: 0,
  })
  assert.equal(receipt.total, 10000)
  assert.equal(receipt.chars, 32)
  assert.ok(receiptLines(receipt).some(line => line.text.includes('10,000 DZD')))
  const bytes58 = buildEscPosBytes(receipt, { width: '58mm' })
  const bytes80 = buildEscPosBytes(receipt, { width: '80mm' })
  assert.ok(bytes58 instanceof Uint8Array)
  assert.deepEqual(Array.from(bytes58.slice(0, 2)), ESC_POS.INIT)
  assert.deepEqual(Array.from(bytes58.slice(-4)), ESC_POS.PARTIAL_CUT)
  assert.notEqual(bytes58.length, bytes80.length)
  assert.equal(latinFallback('فساتين'), 'fsatyn')
  assert.ok(formatDzd(10000).includes('10,000'))
})

test('browser receipt keeps Arabic shaping, escapes HTML and sizes the page', () => {
  const html = receiptHtml({
    width: '80mm',
    store: { name: '<script>بوتيك</script>' },
    items: [{ name: 'قفطان', qty: 1, unitPrice: 7000, lineTotal: 7000 }],
    total: 7000, paid: 7000,
  })
  assert.match(html, /@page \{ size: 80mm auto/)
  assert.match(html, /lang="ar" dir="rtl"/)
  assert.doesNotMatch(html, /<script>بوتيك<\/script>/)
  assert.match(html, /&lt;script&gt;/)
  assert.match(html, /قفطان/)
})

test('all four print transports exist and every new dropdown uses CustomSelect', async () => {
  assert.deepEqual(RECEIPT_TRANSPORT_OPTIONS.map(option => option.value),
    ['browser', 'webusb', 'webbluetooth', 'middleware'])
  assert.equal(canUseWebUsb(), false)
  assert.equal(canUseWebBluetooth(), false)
  assert.ok(BLUETOOTH_PRINT_SERVICES.length >= 3)

  const printer = await read('components/dashboard/ReceiptPrinter.js')
  const transports = await read('lib/printing/transports.js')
  const route = await read('app/api/printing/relay/route.js')
  const pos = await read('app/dashboard/pos/page.js')
  const products = await read('app/dashboard/_screens/products.js')
  const listener = await read('components/dashboard/KeyboardWedgeListener.js')
  const signup = await read('app/signup/page.js')
  const settings = await read('app/dashboard/_screens/settings.js')

  assert.match(printer, /CustomSelect/)
  assert.match(printer, /58mm|80mm/)
  assert.match(transports, /navigator\.usb/)
  assert.match(transports, /navigator\.bluetooth/)
  assert.match(transports, /\/api\/printing\/relay/)
  assert.match(route, /process\.env\.PRINT_MIDDLEWARE_URL/)
  assert.match(route, /AbortSignal\.timeout\(8000\)/)
  assert.match(route, /X-Print-Token/)
  assert.doesNotMatch(route, /body\.url|body\.endpoint/)
  assert.match(pos, /KeyboardWedgeListener/)
  assert.match(pos, /data-barcode-input="pos-search"/)
  assert.match(pos, /ReceiptPrinter/)
  assert.match(products, /KeyboardWedgeListener/)
  assert.match(products, /data-barcode-input="products-search"/)
  assert.match(products, /data-barcode-input="product-barcode"/)
  assert.match(listener, /fillControlledInput/)
  assert.match(signup, /CustomSelect/)
  assert.match(settings, /CustomSelect/)
  for (const source of [printer, pos, products, listener, signup, settings]) {
    assert.doesNotMatch(source, /<select\b/i)
  }
})
