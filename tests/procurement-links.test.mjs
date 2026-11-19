// Real stock tabs, supplier cards, purchases, trips and PostgREST query builder.
// Only the session/router and HTTP transport are fixtures. No live DB or credentials.
import test, { afterEach } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { JSDOM } from 'jsdom'
import { createClient } from '@supabase/supabase-js'

const dom = new JSDOM('<!doctype html><html dir="rtl"><body></body></html>', { url: 'https://local.test/dashboard/stock' })
for (const key of ['window', 'document', 'HTMLElement', 'Node', 'Event', 'MutationObserver']) globalThis[key] = dom.window[key]
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: dom.window.navigator })
globalThis.IS_REACT_ACT_ENVIRONMENT = true
const { createElement } = await import('react')
const { act, render, screen, within, fireEvent, waitFor, cleanup } = await import('@testing-library/react')
afterEach(() => {
  cleanup()
  assert.deepEqual(globalThis.purchaseFixture.unexpected, [], 'no unexpected request or write')
  delete globalThis.purchaseFixture
})

const stubs = {
  'next/navigation': `export const usePathname = () => window.location.pathname;
    export const useSearchParams = () => new URLSearchParams(window.location.search);
    export const useRouter = () => globalThis.purchaseFixture.router`,
  '@/components/dashboard/DashboardShell': 'export default ({children}) => children',
  '@/components/dashboard/SessionProvider': 'export const useDashboardSession = () => globalThis.purchaseFixture.ctx',
  '@/lib/app-context': 'export const getAppContext = async () => globalThis.purchaseFixture.ctx; export const formatDzd = String',
  '@/lib/supabase': 'export const supabase = new Proxy({}, { get: (_, k) => globalThis.purchaseFixture.client[k].bind(globalThis.purchaseFixture.client) })',
}
const outfile = path.resolve('.cache/procurement-links/pages.mjs')
await build({
  stdin: { contents: `export { default as Stock } from './app/dashboard/stock/page';
    export { default as Trips } from './app/dashboard/trips/page'`, resolveDir: process.cwd() },
  outfile, bundle: true, platform: 'node', format: 'esm', jsx: 'automatic',
  loader: { '.js': 'jsx' }, external: ['react', 'react/*', 'react-dom', 'react-dom/*'],
  plugins: [{ name: 'procurement-boundaries', setup(b) {
    b.onResolve({ filter: /.*/ }, ({ path }) => Object.hasOwn(stubs, path) ? { path, namespace: 'stub' } : undefined)
    b.onLoad({ filter: /.*/, namespace: 'stub' }, ({ path }) => ({ contents: stubs[path] }))
    b.onResolve({ filter: /^@\/app\/dashboard\/_screens\/(products|inventory|transfers|offers|looks)$/ }, ({ path }) => ({ path, namespace: 'other-tab' }))
    b.onLoad({ filter: /.*/, namespace: 'other-tab' }, () => ({ contents: 'export default () => null' }))
  } }],
})
const { Stock, Trips } = await import(pathToFileURL(outfile))
const id = n => `00000000-0000-4000-a000-${String(n).padStart(12, '0')}`
const tenant = id(1), store = id(2), sibling = id(3), otherTenant = id(4)
const [a, b, empty, elsewhere, foreign] = [11, 12, 13, 14, 15].map(id)
const base = '/dashboard/stock?tab=purchases'
const filtered = supplier => `${base}&supplierId=${supplier}`
const supplier = (id, goods, store_id = store, tenant_id = tenant) => ({ id, name: 'نفس الاسم', supplied_goods: goods, store_id, tenant_id, total_debt: 0 })
const suppliers = [supplier(a, 'قمصان'), supplier(b, 'أحذية'), supplier(empty, 'فراغ'), supplier(elsewhere, 'فرع آخر', sibling), supplier(foreign, 'مؤسسة أخرى', sibling, otherTenant)]
function invoice(n, supplier_id, description, store_id = store, tenant_id = tenant) {
  return { id: id(100 + n), supplier_id, supplier_name: 'نفس الاسم', description, total_amount: 100,
    created_at: new Date(Date.UTC(2026, 0, 1, 0, 0, n)).toISOString(), store_id, tenant_id }
}
const receipts = [
  ...Array.from({ length: 25 }, (_, i) => invoice(i, a, `A-${i}`)),
  ...Array.from({ length: 25 }, (_, i) => invoice(i + 25, b, `B-${i}`)),
  invoice(50, null, 'بدون مورد'), invoice(51, elsewhere, 'فاتورة فرع آخر', sibling), invoice(52, foreign, 'فاتورة مؤسسة أخرى', sibling, otherTenant),
]

const variantId = id(400)
const trip = (n, purchase_id) => ({ id: id(500 + n), purchase_id, trip_date: '2026-01-01', supplier_name: 'نفس الاسم', goods_cost: 100,
  total_units: 2, cost_per_unit: 5, trip_expenses: 10, store_id: store, tenant_id: tenant, shopping_trip_expenses: [] })
// Same date, supplier and goods total: only purchase_id distinguishes the targets.
const trips = [trip(1, receipts[1].id), trip(2, receipts[0].id), trip(3, null)]
const lines = [0, 1].map(i => ({ id: id(600 + i), variant_id: variantId, purchase_id: receipts[i].id,
  quantity: i + 1, unit_cost: receipts[i].total_amount / (i + 1), store_id: store, tenant_id: tenant }))
const catalog = [{ id: id(401), name: 'قميص', is_active: true, tenant_id: tenant,
  product_variants: [{ id: variantId, color: 'أبيض', size: 'M', cost_price_avg: 9999 }] }]

function mount(href, { role = 'manager', storeId = store, beforeRead, tripRows = trips } = {}) {
  const calls = [], unexpected = []
  const ctx = { role, tenantId: tenant, storeId }
  const sources = { 'rpc/engine_purchases': receipts, 'rpc/engine_suppliers': suppliers, product_variants: [],
    products: catalog, suppliers, shopping_trips: tripRows, purchase_items: lines }
  const client = createClient('https://fixture.test', 'local-test', { accessToken: async () => 'fixture', global: { fetch: async (input, init) => {
    const url = new URL(input), name = url.pathname.replace('/rest/v1/', ''), params = url.searchParams
    const args = name.startsWith('rpc/') ? (init.body ? JSON.parse(init.body) : { p_store: params.get('p_store'), p_tenant: params.get('p_tenant') }) : null
    calls.push({ name, params, args, method: init.method })
    if (!Object.hasOwn(sources, name) || !(init.method === 'GET' || (name.startsWith('rpc/') && init.method === 'POST'))) {
      unexpected.push([init.method, name]); return Response.json({ message: 'unexpected call' }, { status: 400 })
    }
    const error = await beforeRead?.(name, params)
    if (error) return Response.json({ message: error }, { status: 403 })
    let rows = sources[name]
    if (args) rows = rows.filter(row => row.store_id === args.p_store && row.tenant_id === args.p_tenant)
    for (const [key, value] of params) if (value.startsWith('eq.')) rows = rows.filter(row => String(row[key]) === value.slice(3))
    if (params.get('order') === 'created_at.desc') rows = [...rows].sort((a, b) => b.created_at.localeCompare(a.created_at))
    if (params.has('limit')) rows = rows.slice(0, Number(params.get('limit')))
    const fields = (params.get('select') || '').split(/,(?![^()]*\))/).map(key => key.split(/[(!]/)[0])
    return Response.json(rows.map(row => Object.fromEntries(fields.map(key => [key, row[key]]))))
  } } })
  window.history.replaceState(null, '', href)
  const page = () => createElement(window.location.pathname === '/dashboard/trips' ? Trips : Stock)
  const go = href => { window.history.pushState(null, '', href); view.rerender(page()) }
  globalThis.purchaseFixture = { ctx, client, unexpected, router: { replace: go } }
  const view = render(page())
  view.container.addEventListener('click', e => {
    const link = e.target.closest('a[href]')
    if (link) { e.preventDefault(); go(link.href) }
  })
  return { calls, go }
}
const descriptions = () => screen.getAllByRole('row').slice(1).map(row => within(row).getAllByRole('cell')[1].textContent)
const descending = (prefix, last, count) => Array.from({ length: count }, (_, i) => `${prefix}-${last - i}`)
function checkScope(call) {
  assert.deepEqual(call.args, { p_store: store, p_tenant: tenant })
  assert.equal(call.params.get('store_id'), `eq.${store}`); assert.equal(call.params.get('tenant_id'), `eq.${tenant}`)
}

for (const role of ['owner', 'manager']) {
  test(`${role}: supplier card filters by ID before the latest 20, even with 25 newer same-name supplier invoices`, async () => {
    const { calls } = mount('/dashboard/stock?tab=suppliers', { role })
    const card = (await screen.findByText('السلع الموردة: قمصان')).closest('article')
    const link = within(card).getByRole('link', { name: 'عرض مشتريات المورد' })
    assert.equal(link.getAttribute('href'), filtered(a))
    fireEvent.click(link)
    await screen.findByText('A-24')
    assert.deepEqual(descriptions(), descending('A', 24, 20))
    assert.ok(!screen.queryByRole('button', { name: 'حفظ واستلام الفاتورة' }))
    const history = calls.filter(call => call.name === 'rpc/engine_purchases')
    assert.equal(history.length, 1); checkScope(history[0])
    assert.equal(history[0].params.get('supplier_id'), `eq.${a}`)
    assert.equal(history[0].params.get('limit'), '20'); assert.equal(history[0].params.get('order'), 'created_at.desc')
    const resolve = calls.findLast(call => call.name === 'rpc/engine_suppliers')
    checkScope(resolve); assert.equal(resolve.params.get('id'), `eq.${a}`)
  })
}

test('unfiltered tab still shows the original receipt form and the latest 20 invoices for the branch', async () => {
  const { calls } = mount(base)
  await screen.findByText('B-24')
  assert.deepEqual(descriptions(), ['بدون مورد', ...descending('B', 24, 19)])
  screen.getByText('آخر 20 فاتورة شراء'); screen.getByRole('button', { name: 'حفظ واستلام الفاتورة' })
  const history = calls.find(call => call.name === 'rpc/engine_purchases')
  checkScope(history); assert.ok(!history.params.has('supplier_id')); assert.equal(history.params.get('limit'), '20')
})

test('empty supplier history stays empty; switching tabs clears only the supplier filter', async () => {
  mount(`${filtered(empty)}&keep=1`)
  await screen.findByText('لا توجد فواتير لهذا المورد في الفرع الحالي.')
  assert.ok(!screen.queryByRole('table'))
  fireEvent.click(screen.getByRole('tab', { name: 'المخزون' }))
  fireEvent.click(screen.getByRole('tab', { name: 'المشتريات' }))
  assert.equal(window.location.search, '?tab=purchases&keep=1')
  await screen.findByText('B-24')
})

for (const [name, value] of [['other branch', elsewhere], ['other tenant', foreign], ['unknown', id(99)], ['malformed', 'bad-id'], ['empty', ''], ['duplicate', `${a}&supplierId=${b}`]]) {
  test(`${name} supplier ID fails closed; URL cannot override the session branch or tenant`, async () => {
    const { calls } = mount(`${filtered(value)}&storeId=${sibling}&tenantId=${otherTenant}`)
    await screen.findByRole('alert')
    assert.ok(!screen.queryByRole('table')); assert.ok(!calls.some(call => call.name === 'rpc/engine_purchases'))
    calls.forEach(checkScope)
  })
}

test('employee cannot open the purchases tab from a supplier deep link', () => {
  const { calls } = mount(filtered(a), { role: 'employee' })
  assert.ok(!screen.queryByRole('tab', { name: 'المشتريات' }))
  assert.equal(screen.getByRole('tab', { selected: true }).textContent, 'المخزون')
  assert.deepEqual(calls, [])
})

test('a delayed response for one supplier cannot replace another supplier’s history', async () => {
  let release
  const pending = new Promise(resolve => { release = resolve })
  const { calls, go } = mount(filtered(a), { beforeRead: (name, params) => name === 'rpc/engine_purchases' && params.get('supplier_id') === `eq.${a}` ? pending : null })
  await waitFor(() => assert.ok(calls.some(call => call.name === 'rpc/engine_purchases')))
  go(filtered(b))
  await screen.findByText('B-24')
  await act(async () => { release() })
  assert.deepEqual(descriptions(), descending('B', 24, 20))
})

const tripPath = '/dashboard/trips'
const receiptButton = 'عرض فاتورة الرحلة'
for (const role of ['owner', 'manager']) {
  test(`${role}: each trip opens its exact historical invoice and lines by ID, with only GET requests`, async () => {
    const { calls } = mount(tripPath, { role })
    const buttons = await screen.findAllByRole('button', { name: receiptButton })
    assert.equal(buttons.length, 2)
    const history = calls.find(call => call.name === 'shopping_trips')
    assert.ok(history.params.get('select').split(',').includes('purchase_id'))
    assert.equal(history.params.get('store_id'), `eq.${store}`); assert.equal(history.params.get('tenant_id'), `eq.${tenant}`)
    // Keep an unsaved trip draft; viewing a receipt must not submit or reset it.
    const draft = screen.getByLabelText('ملاحظات')
    fireEvent.change(draft, { target: { value: 'مسودة رحلة أخرى' } })
    for (const [index, expected] of [[0, receipts[1]], [1, receipts[0]]]) {
      const at = calls.length
      fireEvent.click(buttons[index])
      const dialog = within(await screen.findByRole('dialog', { name: 'فاتورة الرحلة' }))
      await dialog.findByText(expected.id); dialog.getByText(expected.description)
      const cells = within(dialog.getByRole('table', { name: 'بنود الفاتورة' })).getAllByRole('cell').map(c => c.textContent)
      const line = lines.find(line => line.purchase_id === expected.id)
      assert.deepEqual(cells, ['قميص · أبيض · M', String(line.quantity), String(line.unit_cost)])
      assert.deepEqual(dialog.getAllByRole('button').map(b => b.textContent), ['إغلاق'])
      assert.deepEqual(calls.slice(at).map(c => [c.name, c.method]), [['rpc/engine_purchases', 'GET'], ['purchase_items', 'GET']])
      const [invoiceRead, itemsRead] = calls.slice(at)
      checkScope(invoiceRead); assert.equal(invoiceRead.params.get('id'), `eq.${expected.id}`)
      assert.ok(!invoiceRead.params.has('limit'), 'not clipped by the 20-invoice window')
      assert.equal(itemsRead.params.get('purchase_id'), `eq.${expected.id}`)
      assert.equal(itemsRead.params.get('tenant_id'), `eq.${tenant}`); assert.equal(itemsRead.params.get('store_id'), `eq.${store}`)
      fireEvent.click(dialog.getByRole('button', { name: 'إغلاق' }))
      assert.equal(draft.value, 'مسودة رحلة أخرى'); assert.equal(window.location.pathname, tripPath)
    }
  })
}

test('a trip without purchase_id shows an explanation and offers no invoice action or lookup', async () => {
  const { calls } = mount(tripPath, { tripRows: [trip(3, null)] })
  const message = await screen.findByText('لا توجد فاتورة مرتبطة بهذه الرحلة.')
  const at = calls.length
  assert.ok(!within(message.closest('tr')).queryByRole('button'))
  fireEvent.click(message)
  assert.ok(!screen.queryByRole('dialog')); assert.equal(calls.length, at)
  assert.ok(!calls.some(c => ['rpc/engine_purchases', 'purchase_items'].includes(c.name)))
})

for (const [name, linked] of [['missing', id(404)], ['other branch', receipts.at(-2).id], ['other tenant', receipts.at(-1).id]]) {
  test(`${name} linked invoice: unavailable message, no fallback or line lookup`, async () => {
    const { calls } = mount(tripPath, { tripRows: [trip(9, linked)] })
    fireEvent.click(await screen.findByRole('button', { name: receiptButton }))
    const dialog = within(screen.getByRole('dialog'))
    assert.match((await dialog.findByRole('alert')).textContent, /لم تعد الفاتورة المرتبطة متاحة/)
    assert.ok(!dialog.queryByRole('table'))
    const reads = calls.filter(c => c.name === 'rpc/engine_purchases' || c.name === 'purchase_items')
    assert.equal(reads.length, 1); checkScope(reads[0]); assert.equal(reads[0].params.get('id'), `eq.${linked}`)
  })
}

test('a denied receipt read never retries against a broader source', async () => {
  const { calls } = mount(tripPath, { beforeRead: name => name === 'rpc/engine_purchases' ? 'غير مصرح' : null })
  fireEvent.click((await screen.findAllByRole('button', { name: receiptButton }))[0])
  assert.equal((await within(screen.getByRole('dialog')).findByRole('alert')).textContent, 'غير مصرح')
  assert.deepEqual(calls.slice(3).map(c => c.name), ['rpc/engine_purchases'])
})

test('even a directly mounted trips screen offers employees no invoice read', async () => {
  const { calls } = mount(tripPath, { role: 'employee' })
  await screen.findAllByText('2026-01-01')
  assert.ok(!screen.queryByRole('button', { name: receiptButton }))
  assert.ok(!calls.some(c => ['rpc/engine_purchases', 'purchase_items'].includes(c.name)))
})

test('closing a pending invoice and opening another never shows the first receipt', async () => {
  let release
  const pending = new Promise(resolve => { release = resolve })
  const { calls } = mount(tripPath, { beforeRead: (name, params) => name === 'rpc/engine_purchases' && params.get('id') === `eq.${receipts[1].id}` ? pending : null })
  const buttons = await screen.findAllByRole('button', { name: receiptButton })
  fireEvent.click(buttons[0])
  await waitFor(() => assert.ok(calls.some(c => c.name === 'rpc/engine_purchases')))
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'إغلاق' }))
  fireEvent.click(buttons[1])
  const dialog = within(screen.getByRole('dialog'))
  await dialog.findByText(receipts[0].id)
  await act(async () => { release() })
  dialog.getByText(receipts[0].description)
  assert.ok(!dialog.queryByText(receipts[1].id))
  assert.deepEqual(calls.filter(c => c.name === 'purchase_items').map(c => c.params.get('purchase_id')), [`eq.${receipts[0].id}`])
})
