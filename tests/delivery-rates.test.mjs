import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'

// lib/storefront.js imports the shared pricing module, which a data: URL cannot
// resolve; inlining it keeps this suite dependency-free like the others here.
const offersSource = await fs.readFile(new URL('../lib/offers.js', import.meta.url), 'utf8')
const storefrontSource = (await fs.readFile(new URL('../lib/storefront.js', import.meta.url), 'utf8'))
  .replace(/^import .*$/m, '')
const wilayaSource = (await fs.readFile(new URL('../lib/wilayas.js', import.meta.url), 'utf8'))
  .replace(/^import .*$/gm, '')

const { orderMessage } = await import(
  `data:text/javascript;base64,${Buffer.from(`${offersSource}\n${storefrontSource}`).toString('base64')}`)
const { WILAYAS } = await import(
  `data:text/javascript;base64,${Buffer.from(wilayaSource).toString('base64')}`)
// lib/delivery.js only imports './wilayas.js' with its extension, so it loads
// directly and is tested as the checkout actually uses it.
const { normalizeDeliveryRates, deliveryFeeFor, wilayaCodeOf } = await import('../lib/delivery.js')

// Delivery pricing has two halves that must agree: the SQL decides the fee, the
// sheet only shows it. The SQL half was exercised against a real PostgreSQL 16
// (24 assertions, including a tampered fee) before being committed here.

const read = path => fs.readFile(new URL(path, import.meta.url), 'utf8')
const migration = await read('../supabase/migrations/202611120007_delivery_rates.sql')
const repair = await read('../supabase/migrations/202611120008_delivery_rates_repair.sql')
const cartSheet = await read('../components/store/CartSheet.js')
const settings = await read('../app/dashboard/_screens/settings.js')

const code = migration.split('\n').filter(line => !line.trim().startsWith('--')).join('\n')
// Collapse layout whitespace so the guards read the SQL, not its indentation.
const strip = source => source
  .replace(/\s+/g, ' ')
  .replace(/ ?([,)])/g, '$1')
  .replace(/\( ?/g, '(')

test('delivery_rates lives on stores and defaults to an empty table', () => {
  assert.match(code, /ALTER TABLE public\.stores\s+ADD COLUMN IF NOT EXISTS delivery_rates jsonb/)
  assert.match(code, /SET delivery_rates = '\{\}'::jsonb WHERE delivery_rates IS NULL/)
  assert.match(code, /ALTER COLUMN delivery_rates SET DEFAULT '\{\}'::jsonb/)
  assert.match(code, /ALTER COLUMN delivery_rates SET NOT NULL/)
  // A scalar or an array would break the `-> code` lookup at checkout.
  assert.match(code, /CHECK \(jsonb_typeof\(delivery_rates\) = 'object'\)/)
})

test('the rate editor refuses anything the checkout cannot trust', () => {
  const flat = strip(code)
  assert.match(flat, /CREATE OR REPLACE FUNCTION public\.engine_update_delivery_rates\(p_store uuid, p_rates jsonb\)/)
  assert.match(flat, /IF p_rates IS NULL OR jsonb_typeof\(p_rates\) <> 'object' THEN/)
  // Keys are two-digit wilaya codes 01..58 …
  assert.match(flat, /FROM jsonb_each\(p_rates\) e WHERE e\.key !~ '\^\[0-9\]\{2\}\$'/)
  assert.match(flat, /e\.key::integer NOT BETWEEN 1 AND 58/)
  // … and values are whole, non-negative dinars.
  assert.match(flat, /jsonb_typeof\(e\.value\) <> 'number'/)
  assert.match(flat, /<> trunc\(\(e\.value #>> '\{\}'\)::numeric\)/)
  assert.match(flat, /\(e\.value #>> '\{\}'\)::numeric < 0/)
  assert.match(flat, /\(e\.value #>> '\{\}'\)::numeric > 1000000/)
  // Only staff of this store may rewrite the table.
  assert.match(flat, /PERFORM public\.engine_staff\(p_store, v_tenant\)/)
})

test('create_order prices delivery itself and only trusts the wilaya code', () => {
  const flat = strip(code)
  assert.match(flat, /CREATE OR REPLACE FUNCTION public\.create_order\(p_store_id uuid, p_customer jsonb, p_items jsonb, p_source text, p_wilaya text, p_delivery_fee integer\)/)
  // The fee is read from the store row, never from p_delivery_fee.
  assert.match(flat, /rate := s\.delivery_rates -> clean_wilaya/)
  assert.match(flat, /delivery_fee := \(rate #>> '\{\}'\)::integer/)
  assert.match(flat, /IF coalesce\(jsonb_typeof\(s\.delivery_rates\), 'null'\) <> 'object' OR NOT \(s\.delivery_rates \? clean_wilaya\) THEN/)
  assert.match(flat, /'التوصيل غير متاح لهذه الولاية'/)
  // A client number that disagrees with the table is a rejection, not a price.
  assert.match(flat, /IF p_delivery_fee IS NOT NULL AND p_delivery_fee IS DISTINCT FROM delivery_fee THEN RAISE EXCEPTION 'رسوم التوصيل غير مطابقة'/)
  // Pickup forces zero and refuses a fee.
  assert.match(flat, /delivery_fee := 0;/)
  assert.match(flat, /IF p_delivery_fee IS NOT NULL AND p_delivery_fee <> 0 THEN/)
})

test('the old four-argument signature still exists for deployed clients', () => {
  const flat = strip(code)
  assert.match(flat, /CREATE OR REPLACE FUNCTION public\.create_order\(p_store_id uuid, p_customer jsonb, p_items jsonb, p_source text\)/)
  assert.match(flat, /SELECT public\.create_order\(p_store_id, p_customer, p_items, p_source, NULL, NULL\)/)
  assert.match(flat, /GRANT EXECUTE ON FUNCTION public\.create_order\(uuid,jsonb,jsonb,text\) TO anon, authenticated/)
})

test('the storefront can read the rate table without the dashboard', () => {
  const flat = strip(code)
  assert.match(flat, /'delivery_rates', coalesce\(s\.delivery_rates, '\{\}'::jsonb\)/)
  assert.match(flat, /GRANT EXECUTE ON FUNCTION public\.engine_update_delivery_rates\(uuid,jsonb\) TO authenticated/)
  assert.doesNotMatch(flat, /GRANT EXECUTE ON FUNCTION public\.engine_update_delivery_rates[^;]*\banon\b/)
})

// --- client half -------------------------------------------------------

test('checkout sends the wilaya and the fee it displayed', () => {
  const flat = strip(cartSheet)
  assert.match(flat, /p_wilaya: fulfillment === 'delivery' \? \(wilayaCodeOf\(wilaya\) \|\| wilaya\) : null/)
  assert.match(flat, /p_delivery_fee: appliedFee/)
  // Pickup is free even if a wilaya was picked earlier.
  assert.match(flat, /const appliedFee = fulfillment === 'delivery' \? deliveryFee : 0/)
  // Confirm must never be blocked by delivery pricing.
  assert.match(flat, /onClick=\{confirm\} disabled=\{busy\}/)
})

test('selecting a wilaya looks the fee up immediately', () => {
  const flat = strip(cartSheet)
  assert.match(flat, /function chooseWilaya\(value\) \{ setWilaya\(value\);? setDeliveryFee\(fulfillment === 'delivery' \? \(deliveryFeeFor\(rateTable, value\) \?\? 0\) : 0\) \}/)
  assert.match(flat, /onChange=\{chooseWilaya\}/)
  // Rates that arrive after the sheet mounts still update the fee.
  assert.match(flat, /useEffect\(\(\) => \{ const fee = fulfillment === 'delivery' && wilaya \? deliveryFeeFor\(rateTable, wilaya\) : null;? setDeliveryFee\(fee \?\? 0\);? \}, \[rateTable, wilaya, fulfillment\]\)/)
})

test('the fee is rendered to the customer', () => {
  const flat = strip(cartSheet)
  assert.match(flat, /سعر التوصيل\{wilayaName \? ` — \$\{wilayaName\}` : ''\}/)
  assert.match(flat, /deliveryFee > 0 \? formatMoney\(deliveryFee\) : 'اختر الولاية'/)
  assert.match(flat, /لم يحدّد المحل أسعار التوصيل بعد/)
})

test('the shown total is goods plus delivery', () => {
  const flat = strip(cartSheet)
  assert.match(flat, /const grandTotal = total \+ appliedFee/)
  assert.match(flat, /<span>الإجمالي<\/span><span>\{formatMoney\(grandTotal\)\}<\/span>/)
})

// --- the lookup itself -------------------------------------------------

test('rate keys are read whether they are codes, padded codes or names', () => {
  assert.deepEqual(normalizeDeliveryRates({ 16: 400, 31: 600 }), { 16: 400, 31: 600 })
  assert.deepEqual(normalizeDeliveryRates({ '016': 500 }), { 16: 500 })
  assert.deepEqual(normalizeDeliveryRates({ '9': 300 }), { '09': 300 })
  assert.deepEqual(normalizeDeliveryRates({ 'البليدة': 450 }), { '09': 450 })
  assert.deepEqual(normalizeDeliveryRates({ 'بليدة': 450 }), { '09': 450 })
  assert.deepEqual(normalizeDeliveryRates({ '16 - البليدة': 450 }), { 16: 450 })
  // Prices written as text, with the currency, or nested.
  assert.deepEqual(normalizeDeliveryRates({ '16': '400' }), { 16: 400 })
  assert.deepEqual(normalizeDeliveryRates({ '16': '400 دج' }), { 16: 400 })
  assert.deepEqual(normalizeDeliveryRates({ '16': { price: 400 } }), { 16: 400 })
  // A jsonb value that still arrives as a string is parsed.
  assert.deepEqual(normalizeDeliveryRates('{"16":"450"}'), { 16: 450 })
})

test('rubbish keys and prices are dropped, never turned into 0', () => {
  assert.deepEqual(normalizeDeliveryRates({ '99': 100 }), {})
  assert.deepEqual(normalizeDeliveryRates({ '16': 'abc' }), {})
  assert.deepEqual(normalizeDeliveryRates({ '16': -5 }), {})
  assert.deepEqual(normalizeDeliveryRates({}), {})
  assert.deepEqual(normalizeDeliveryRates(null), {})
  assert.deepEqual(normalizeDeliveryRates('[1,2]'), {})
  assert.deepEqual(normalizeDeliveryRates('not json'), {})
})

test('duplicates resolve the same way the SQL repair resolves them', () => {
  // A canonical code beats a hand-typed name; inside a group the first wins.
  assert.deepEqual(normalizeDeliveryRates({ '09': 900, 'بليدة': 600 }), { '09': 900 })
  assert.deepEqual(
    normalizeDeliveryRates({ '9': 400, '016': 500, 'البليدة': 600, 'بليدة': '700 دج', 'أدرار': '800', '99': 100, '16': 'abc' }),
    { 16: 500, '09': 400, '01': 800 },
  )
})

test('the fee lookup normalises the wilaya the dropdown sends', () => {
  const table = { '16': 400, '31': 600 }
  assert.equal(deliveryFeeFor(table, '16'), 400)
  assert.equal(deliveryFeeFor(table, 16), 400)
  assert.equal(deliveryFeeFor(table, '016'), 400)
  assert.equal(deliveryFeeFor(table, '31'), 600)
  assert.equal(deliveryFeeFor(table, '09'), null)
  assert.equal(deliveryFeeFor({ '09': 350 }, 'البليدة'), 350)
  assert.equal(deliveryFeeFor({}, '16'), null)
  // 0 is a real fee (free delivery), not "missing".
  assert.equal(deliveryFeeFor({ '16': 0 }, '16'), 0)
  assert.equal(wilayaCodeOf('16'), '16')
  assert.equal(wilayaCodeOf(''), '')
  assert.equal(WILAYAS.length, 58)
})

test('the repair migration folds hand-written keys into canonical codes', () => {
  assert.match(repair, /CREATE OR REPLACE FUNCTION public\.engine_wilaya_code\(p_value text\)/)
  assert.match(repair, /digits::integer BETWEEN 1 AND 58/)
  assert.match(repair, /jsonb_typeof\(delivery_rates\) = 'object'/)
  // Canonical keys are visited first so the outcome is not iteration luck.
  assert.match(repair, /ORDER BY canonical DESC, key/)
  assert.match(repair, /AND NOT \(rebuilt \? code\)/)
  // It must be safe to run twice.
  assert.match(repair, /IF rebuilt <> store_row\.delivery_rates THEN/)
})

test('the settings screen edits all 58 wilayas through the RPC', () => {
  const flat = strip(settings)
  assert.match(flat, /select\('name, address, phone, google_maps_url, receipt_footer, tax_rc, logo_on_receipt, prices_on_receipt, return_policy_days, low_stock_alert, enable_barcode, logo_url, delivery_rates'\)/)
  assert.match(flat, /supabase\.rpc\('engine_update_delivery_rates', \{ p_store: ctx\.storeId, p_rates: payload,? \}\)/)
  assert.match(flat, /WILAYAS\.map\(wilaya => \(/)
  assert.equal(WILAYAS.length, 58)
})

// --- the message the shop receives on WhatsApp -------------------------

const cart = [{ productName: 'قميص', size: 'M', color: 'أسود', qty: 2, subtotal: 4000 }]

test('the WhatsApp message shows the delivery fee and the real total', () => {
  const message = orderMessage({ storeName: 'متجري', cart, total: 4000, deliveryFee: 400, customer: { name: 'علي' } })
  assert.match(message, /رسوم التوصيل: 400 دج/)
  assert.match(message, /الإجمالي: 4 400 دج/)
})

test('a pickup message stays free and unchanged', () => {
  const message = orderMessage({ storeName: 'متجري', cart, total: 4000, customer: { name: 'علي', fulfillment: 'pickup' } })
  assert.doesNotMatch(message, /رسوم التوصيل/)
  assert.match(message, /الإجمالي: 4 000 دج/)
})
