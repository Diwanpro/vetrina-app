// Pure receipt model for POS thermal printing (P5).
//
// Browser printing keeps Arabic shaping through the browser's text engine;
// ESC/POS bytes are transliterated to safe PC437/ASCII text in escpos.js because
// most 58mm/80mm printers do not shape Arabic. Both paths share this model.

export const RECEIPT_WIDTHS = Object.freeze([
  { value: '58mm', label: 'حرارية 58 مم', chars: 32 },
  { value: '80mm', label: 'حرارية 80 مم', chars: 48 },
])

export const RECEIPT_WIDTH_OPTIONS = Object.freeze(
  RECEIPT_WIDTHS.map(width => ({ label: width.label, value: width.value })),
)

export const RECEIPT_TRANSPORTS = Object.freeze([
  { value: 'browser', label: 'طباعة المتصفح (نص عربي مشكّل)' },
  { value: 'webusb', label: 'WebUSB · ESC/POS' },
  { value: 'webbluetooth', label: 'WebBluetooth · ESC/POS' },
  { value: 'middleware', label: 'Print middleware · ESC/POS' },
])

export const RECEIPT_TRANSPORT_OPTIONS = Object.freeze(
  RECEIPT_TRANSPORTS.map(transport => ({ label: transport.label, value: transport.value })),
)

export function receiptWidth(value) {
  return RECEIPT_WIDTHS.find(width => width.value === value) || RECEIPT_WIDTHS[1]
}

export function formatDzd(value) {
  const amount = Math.round(Number(value) || 0)
  return `\u2066${amount.toLocaleString('en-US')} دج\u2069`
}

export function formatAsciiMoney(value) {
  const amount = Math.round(Number(value) || 0)
  return `${amount.toLocaleString('en-US')} DZD`
}

export function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

// A compact transliteration for ESC/POS codepage 0 (PC437). Product names stay
// readable enough on a receipt; the browser path renders the Arabic original.
const ARABIC_TO_LATIN = Object.freeze({
  'ا': 'a', 'أ': 'a', 'إ': 'i', 'آ': 'a', 'ب': 'b', 'ت': 't', 'ث': 'th', 'ج': 'j', 'ح': 'h', 'خ': 'kh',
  'د': 'd', 'ذ': 'dh', 'ر': 'r', 'ز': 'z', 'س': 's', 'ش': 'sh', 'ص': 's', 'ض': 'd', 'ط': 't', 'ظ': 'z',
  'ع': 'a', 'غ': 'gh', 'ف': 'f', 'ق': 'q', 'ك': 'k', 'ل': 'l', 'م': 'm', 'ن': 'n', 'ه': 'h', 'و': 'w',
  'ي': 'y', 'ى': 'a', 'ة': 'a', 'ئ': 'y', 'ء': '', 'ؤ': 'w', 'أ': 'a', 'إ': 'i', 'آ': 'a',
  'َ': '', 'ُ': '', 'ِ': '', 'ً': '', 'ٌ': '', 'ٍ': '', 'ّ': '', 'ْ': '',
  '،': ',', '؛': ';', '؟': '?', ' ': ' ', 'ـ': '',
})

export function latinFallback(text) {
  return String(text ?? '')
    .split('')
    .map(char => {
      if (ARABIC_TO_LATIN[char] !== undefined) return ARABIC_TO_LATIN[char]
      const code = char.codePointAt(0)
      // Arabic-Indic digits become ASCII; everything outside safe ASCII becomes '-'.
      if (code >= 0x0660 && code <= 0x0669) return String(code - 0x0660)
      if (code >= 32 && code <= 126) return char
      return '-'
    })
    .join('')
    .replace(/--+/g, '-')
    .trim()
}

export function normalizeReceipt(input = {}) {
  const width = receiptWidth(input.width)
  const items = (input.items || []).map((item, index) => {
    const qty = Math.max(1, Math.round(Number(item.qty) || 1))
    const unitPrice = Math.round(Number(item.unitPrice ?? item.price) || 0)
    const lineTotal = Math.round(Number(item.lineTotal ?? item.subtotal ?? unitPrice * qty) || 0)
    return {
      key: item.key || `${index}-${item.name || ''}`,
      name: String(item.name || 'منتج'),
      color: String(item.color || ''),
      size: String(item.size || ''),
      qty,
      unitPrice,
      lineTotal,
    }
  })
  const total = Math.round(Number(input.total ?? items.reduce((sum, item) => sum + item.lineTotal, 0)) || 0)
  const paid = Math.max(0, Math.round(Number(input.paid) || 0))
  const credit = Math.max(0, Math.round(Number(input.credit ?? total - paid) || 0))
  const store = input.store || {}
  const date = input.date ? new Date(input.date) : new Date()
  return {
    width: width.value,
    chars: width.chars,
    number: String(input.number || `POS-${Date.now()}`),
    date: Number.isNaN(date.getTime()) ? new Date() : date,
    storeName: String(store.name || input.storeName || 'Vetrina'),
    storePhone: String(store.phone || input.storePhone || ''),
    storeAddress: String(store.address || input.storeAddress || ''),
    footer: String(store.receipt_footer || input.footer || 'شكراً لزيارتكم'),
    taxRc: String(store.tax_rc || input.taxRc || ''),
    logoUrl: String(store.logo_url || input.logoUrl || ''),
    items,
    total,
    paid,
    credit,
    payment: String(input.payment || 'cash'),
    paymentLabel: String(input.paymentLabel || ({
      cash: 'نقداً', check: 'شيك', ccp: 'CCP', card: 'بطاقة',
    }[input.payment] || input.payment || 'نقداً')),
    isMock: Boolean(input.isMock),
  }
}

/** Ordered lines used by ESC/POS and by the on-screen preview. */
export function receiptLines(receipt) {
  const data = normalizeReceipt(receipt)
  const divider = '-'.repeat(data.chars)
  const lines = [
    { text: data.storeName, align: 'center', bold: true },
    { text: data.storePhone, align: 'center' },
    { text: data.storeAddress, align: 'center' },
    { text: `فاتورة ${data.number}`, align: 'center' },
    { text: data.date.toLocaleString('ar-DZ'), align: 'center' },
    { text: divider, align: 'left' },
  ]
  for (const item of data.items) {
    lines.push({ text: item.name, align: 'left' })
    const variant = [item.color, item.size].filter(Boolean).join(' / ')
    if (variant) lines.push({ text: variant, align: 'left' })
    lines.push({ text: `${item.qty} × ${formatAsciiMoney(item.unitPrice)}`, align: 'left' })
    lines.push({ text: formatAsciiMoney(item.lineTotal), align: 'right' })
  }
  lines.push({ text: divider, align: 'left' })
  lines.push({ text: `الإجمالي: ${formatAsciiMoney(data.total)}`, align: 'right', bold: true })
  lines.push({ text: `المدفوع: ${formatAsciiMoney(data.paid)}`, align: 'right' })
  lines.push({ text: `المتبقي: ${formatAsciiMoney(data.credit)}`, align: 'right' })
  lines.push({ text: `الدفع: ${data.paymentLabel}`, align: 'center' })
  if (data.taxRc) lines.push({ text: `RC: ${data.taxRc}`, align: 'center' })
  lines.push({ text: data.footer, align: 'center' })
  return lines
}

/** Browser-shaped Arabic receipt, printable on 58mm/80mm thermal paper. */
export function receiptHtml(receipt) {
  const data = normalizeReceipt(receipt)
  const width = data.width
  const items = data.items.map(item => `
    <tr>
      <td class="name">${escapeHtml(item.name)}${item.color || item.size ? `<small>${escapeHtml([item.color, item.size].filter(Boolean).join(' · '))}</small>` : ''}</td>
      <td class="num">${item.qty}</td>
      <td class="num">${escapeHtml(formatDzd(item.lineTotal))}</td>
    </tr>`).join('')
  const logo = /^https?:\/\//i.test(data.logoUrl)
    ? `<img class="logo" src="${escapeHtml(data.logoUrl)}" alt="" />` : ''
  return `<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8" />
<title>${escapeHtml(data.storeName)} · ${escapeHtml(data.number)}</title>
<style>
  @page { size: ${width} auto; margin: 2mm; }
  * { box-sizing: border-box; }
  body { width: ${width}; margin: 0; padding: 2mm; color: #111; background: #fff;
         font-family: Tajawal, Tahoma, Arial, sans-serif; font-size: ${width === '58mm' ? '10px' : '12px'}; }
  .center { text-align: center; }
  .logo { max-width: 70%; max-height: 18mm; object-fit: contain; margin: 0 auto 2mm; display: block; }
  h1 { font-size: 15px; margin: 0 0 2mm; }
  p { margin: 1mm 0; }
  hr { border: 0; border-top: 1px dashed #111; margin: 2mm 0; }
  table { width: 100%; border-collapse: collapse; table-layout: fixed; }
  td { padding: 1mm 0; vertical-align: top; }
  .name { text-align: right; word-break: break-word; }
  .name small { display: block; color: #555; font-size: 9px; }
  .num { text-align: left; width: ${width === '58mm' ? '22%' : '18%'}; white-space: nowrap; }
  .total { font-weight: 700; font-size: 13px; }
  .footer { margin-top: 3mm; text-align: center; font-size: 10px; }
</style></head><body>
  ${logo}
  <div class="center"><h1>${escapeHtml(data.storeName)}</h1>
  ${data.storePhone ? `<p>${escapeHtml(data.storePhone)}</p>` : ''}
  ${data.storeAddress ? `<p>${escapeHtml(data.storeAddress)}</p>` : ''}
  <p>فاتورة ${escapeHtml(data.number)}</p>
  <p>${escapeHtml(data.date.toLocaleString('ar-DZ'))}</p></div>
  <hr />
  <table><tbody>${items}</tbody></table>
  <hr />
  <table><tbody>
    <tr class="total"><td>الإجمالي</td><td colspan="2" class="num">${escapeHtml(formatDzd(data.total))}</td></tr>
    <tr><td>المدفوع</td><td colspan="2" class="num">${escapeHtml(formatDzd(data.paid))}</td></tr>
    <tr><td>المتبقي</td><td colspan="2" class="num">${escapeHtml(formatDzd(data.credit))}</td></tr>
    <tr><td>الدفع</td><td colspan="2" class="num">${escapeHtml(data.paymentLabel)}</td></tr>
    ${data.taxRc ? `<tr><td>RC</td><td colspan="2" class="num">${escapeHtml(data.taxRc)}</td></tr>` : ''}
  </tbody></table>
  <p class="footer">${escapeHtml(data.footer)}</p>
</body></html>`
}
