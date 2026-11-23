import test, { afterEach } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { JSDOM } from 'jsdom'

const dom = new JSDOM('<html><body></body></html>', { url: 'https://local.test/dashboard/stock?tab=inventory' })
for (const key of ['window', 'document', 'HTMLElement', 'Node', 'MutationObserver', 'Event']) globalThis[key] = dom.window[key]
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: dom.window.navigator })
globalThis.IS_REACT_ACT_ENVIRONMENT = true
const { createElement: h } = await import('react')
const { render, screen, fireEvent, waitFor, act, cleanup } = await import('@testing-library/react')
afterEach(cleanup)
const outfile = path.resolve('.cache/manual-stock-ui/modal.mjs')
await build({ stdin: { contents: "export {default} from './components/dashboard/ManualStockModal.js'; export {default as InventoryPage} from './app/dashboard/_screens/inventory.js';", resolveDir: process.cwd() }, outfile, bundle: true, platform: 'node', format: 'esm', jsx: 'automatic', loader: { '.js': 'jsx' }, external: ['react', 'react/*', 'react-dom', 'react-dom/*'], plugins: [{ name: 'stock-client', setup(b) {
  b.onResolve({ filter: /^@\/lib\/supabase$/ }, () => ({ path: 'client', namespace: 'stock-test' }))
  b.onResolve({ filter: /^@\/lib\/app-context$/ }, () => ({ path: 'context', namespace: 'stock-boundary' }))
  b.onResolve({ filter: /^@\/components\/dashboard\/(OosAlerts|MasterStock)$/ }, () => ({ path: 'silent', namespace: 'stock-boundary' }))
  b.onLoad({ filter: /.*/, namespace: 'stock-boundary' }, args => ({ contents: args.path === 'context' ? 'export const getAppContext=async()=>globalThis.stockContext' : 'export default function Silent(){return null}' }))
  b.onLoad({ filter: /.*/, namespace: 'stock-test' }, () => ({ contents: 'export const supabase={from:(...a)=>globalThis.stockClient.from(...a),rpc:(...a)=>globalThis.stockClient.rpc(...a)}' }))
} }] })
const { default: Modal, InventoryPage } = await import(pathToFileURL(outfile))
const variant = (id, color = 'أسود') => ({ id, color, size: 'M', barcode: id, cost_price_avg: 1200 })
const shoe = { id: 'shoe', name: 'حذاء رجالي', product_variants: [variant('v1')] }
const jeans = { id: 'jeans', name: 'بنطال جينز', product_variants: [variant('v2'), variant('v3', 'أزرق')] }
function fixture(rows = [shoe, jeans], ctxPatch = {}) {
  const queries = [], rpc = []
  let response = async () => ({ data: rows, error: null })
  globalThis.stockClient = {
    from(table) {
      const calls = [['from', table]]; queries.push(calls)
      const q = { range: (...args) => { calls.push(['range', ...args]); return response() } }
      for (const op of ['select', 'eq', 'order']) q[op] = (...args) => { calls.push([op, ...args]); return q }
      return q
    },
    rpc: async (...args) => { rpc.push(args); return { error: null } },
  }
  const ctx = { role: 'owner', tenantId: 'tenant', storeId: 'branch', allBranches: false, ...ctxPatch }
  const props = { open: true, ctx, onClose() {}, onSaved() {} }
  return { props, queries, rpc, setResponse(fn) { response = fn }, mount() { return render(h(Modal, props)) } }
}
async function choose(label, option) {
  fireEvent.click(screen.getByRole('button', { name: label }))
  fireEvent.click(await screen.findByRole('option', { name: option }))
}
async function ready() { await waitFor(() => assert.equal(screen.getByRole('button', { name: 'المنتج' }).disabled, false)) }

test('all-branches mode explains branch requirement, skips query and blocks submission', () => {
  const f = fixture([], { storeId: null, allBranches: true }); f.mount()
  assert.ok(screen.getByText('يرجى اختيار فرع محدد من الشريط العلوي أولاً'))
  assert.equal(screen.getByRole('button', { name: 'إضافة المخزون' }).disabled, true)
  assert.equal(f.queries.length, 0); assert.equal(f.rpc.length, 0)
})
test('active catalog loads without inventory join; a single variant is auto-selected and saved', async () => {
  const f = fixture(); f.mount(); await ready()
  assert.ok(f.queries[0].some(c => c[0] === 'eq' && c[1] === 'is_active' && c[2] === true))
  assert.ok(f.queries[0].some(c => c[0] === 'eq' && c[1] === 'tenant_id' && c[2] === 'tenant'))
  assert.ok(!f.queries[0].find(c => c[0] === 'select')[1].includes('inventory'))
  await choose('المنتج', 'حذاء رجالي')
  assert.match(screen.getByRole('button', { name: 'المقاس / اللون' }).textContent, /أسود \/ M/)
  fireEvent.change(screen.getByLabelText('الكمية'), { target: { value: '10' } })
  fireEvent.change(screen.getByLabelText('سعر التكلفة للوحدة (دج)'), { target: { value: '1200' } })
  fireEvent.click(screen.getByRole('button', { name: 'إضافة المخزون' }))
  await waitFor(() => assert.equal(f.rpc.length, 1))
  assert.equal(f.rpc[0][0], 'engine_add_stock_manual')
  assert.equal(f.rpc[0][1].p_variant, 'v1'); assert.equal(f.rpc[0][1].p_store, 'branch'); assert.equal(f.rpc[0][1].p_quantity, 10)
})
test('multiple variants populate on product selection and require an explicit choice', async () => {
  const f = fixture(); f.mount(); await ready(); await choose('المنتج', 'حذاء رجالي'); await choose('المنتج', 'بنطال جينز')
  assert.equal(screen.getByRole('button', { name: 'إضافة المخزون' }).disabled, true)
  await choose('المقاس / اللون', /أزرق \/ M/)
  assert.equal(screen.getByRole('button', { name: 'إضافة المخزون' }).disabled, false)
})
test('empty active catalog is explained, not silently displayed as a broken dropdown', async () => {
  const f = fixture([]); f.mount()
  await screen.findByText(/لا توجد منتجات نشطة متاحة/)
  assert.equal(screen.getByRole('button', { name: 'المنتج' }).disabled, true)
  assert.equal(screen.getByRole('link', { name: 'فتح المنتجات' }).getAttribute('href'), '/dashboard/stock?tab=products')
})
test('query error has retry and recovers', async () => {
  const f = fixture(); f.setResponse(async () => ({ data: null, error: new Error('فشل الاتصال') })); f.mount()
  await screen.findByText('فشل الاتصال')
  f.setResponse(async () => ({ data: [shoe], error: null }))
  fireEvent.click(screen.getByRole('button', { name: 'إعادة تحميل المنتجات' }))
  await ready(); await choose('المنتج', 'حذاء رجالي'); assert.equal(f.queries.length, 2)
})
test('product without variants gives a specific explanation', async () => {
  const f = fixture([{ id: 'empty', name: 'منتج بلا مقاسات', product_variants: [] }]); f.mount(); await ready()
  await choose('المنتج', 'منتج بلا مقاسات')
  assert.ok(screen.getByText(/هذا المنتج لا يحتوي على مقاسات/))
  assert.equal(screen.getByRole('button', { name: 'المقاس / اللون' }).disabled, true)
})
test('employee cannot load or submit a stock adjustment', () => {
  const f = fixture([], { role: 'employee' }); f.mount()
  assert.ok(screen.getByText('إضافة المخزون متاحة للمالك والمدير فقط')); assert.equal(f.queries.length, 0)
})
test('initial variant shortcut works and late responses from old scopes are ignored', async () => {
  const f = fixture(); f.props.initialVariant = 'v2'; const view = f.mount(); await ready()
  await waitFor(() => assert.match(screen.getByRole('button', { name: 'المنتج' }).textContent, /بنطال جينز/))
  assert.match(screen.getByRole('button', { name: 'المقاس / اللون' }).textContent, /v2/)
  let resolve
  f.setResponse(() => new Promise(r => { resolve = r }))
  view.rerender(h(Modal, { ...f.props, ctx: { ...f.props.ctx, storeId: 'other' } }))
  assert.ok(screen.getByRole('status').textContent.includes('جاري تحميل المنتجات...'))
  view.rerender(h(Modal, { ...f.props, ctx: { ...f.props.ctx, storeId: null, allBranches: true } }))
  await act(async () => resolve({ data: [shoe], error: null }))
  assert.ok(screen.getByText('يرجى اختيار فرع محدد من الشريط العلوي أولاً'))
  assert.equal(screen.getByRole('button', { name: 'إضافة المخزون' }).disabled, true)
})


test('inventory labels inactive stock and disables replenishing it while active stock remains usable', async () => {
  const ctx = { role: 'owner', tenantId: 'tenant', storeId: 'branch', storeIds: ['branch'], allBranches: false }
  globalThis.stockContext = ctx
  const data = [false, true].map((is_active, i) => ({ id: 'row' + i, quantity: 0, product_variants: { id: 'v' + i, color: 'أسود', size: 'M', products: { name: is_active ? 'منتج نشط' : 'منتج مؤرشف', tenant_id: 'tenant', is_active } } }))
  globalThis.stockClient = { from(table) {
    const q = { range: async () => ({ data }), single: async () => ({ data: { low_stock_alert: 10 } }) }
    for (const op of ['select', 'eq', 'order']) q[op] = () => q
    return q
  } }
  render(h(InventoryPage))
  await screen.findByText('منتج مؤرشف')
  assert.ok(screen.getByText('منتج غير نشط — الرصيد معروض للمراجعة فقط'))
  const buttons = screen.getAllByRole('button', { name: 'إضافة كمية' })
  assert.equal(buttons[0].disabled, true); assert.equal(buttons[1].disabled, false)
})
