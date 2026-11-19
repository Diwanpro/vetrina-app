// Exercise the real Settings screen (including ShippingSettings and its selects).
// Only session, device/local data, Supabase and fetch are replaced. No live writes.
import test, { afterEach } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { JSDOM } from 'jsdom'

const dom = new JSDOM('<!doctype html><html dir="rtl"><body></body></html>', { url: 'https://local.test/dashboard/settings' })
for (const key of ['window', 'document', 'HTMLElement', 'Node', 'Event', 'MutationObserver']) globalThis[key] = dom.window[key]
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: dom.window.navigator })
globalThis.IS_REACT_ACT_ENVIRONMENT = true
const { createElement } = await import('react')
const { act, render, screen, within, fireEvent, waitFor, cleanup } = await import('@testing-library/react')
const originalFetch = globalThis.fetch
afterEach(() => { cleanup(); globalThis.fetch = originalFetch; delete globalThis.settingsFixture })

const stubs = {
  '@/components/dashboard/SessionProvider': 'export const useDashboardSession = () => globalThis.settingsFixture.ctx',
  '@/lib/supabase': 'export const supabase = new Proxy({}, { get: (_, key) => globalThis.settingsFixture.client[key] })',
  '@/lib/device': 'export const describeDevice = async () => ({fingerprint: "local-test"})',
  '@/lib/local-db': 'export const localRows = async () => []; export const pendingRows = localRows',
  '@/lib/sync': 'export const syncPending = async () => {}',
  '@/lib/app-context': 'export const formatDzd = String',
}
const outfile = path.resolve('.cache/settings-ui/screen.mjs')
await build({
  entryPoints: ['app/dashboard/_screens/settings.js'], outfile, bundle: true, platform: 'node', format: 'esm',
  jsx: 'automatic', loader: { '.js': 'jsx' }, external: ['react', 'react/*', 'react-dom', 'react-dom/*', 'qrcode.react'],
  plugins: [{ name: 'settings-boundaries', setup(b) {
    b.onResolve({ filter: /^@\// }, args => Object.hasOwn(stubs, args.path) ? { path: args.path, namespace: 'stub' } : undefined)
    b.onLoad({ filter: /.*/, namespace: 'stub' }, args => ({ contents: stubs[args.path] }))
  } }],
})
const Settings = (await import(pathToFileURL(outfile))).default

async function mount(role = 'manager') {
  const store = { name: 'محل تجريبي', store_type: 'mens', theme_key: 'classic', slug: 'fixture', delivery_rates: { '07': 450, '16': 650 } }
  const ctx = { role, user: { id: 'user-1' }, storeId: 'branch-1', assignedStoreId: 'branch-1', tenantId: 'tenant-1', storeType: 'mens', themeKey: 'classic',
    stores: [{ id: 'branch-1', name: store.name }], tenant: { name: 'مؤسسة تجريبية', is_active: true, branches_limit: 2 } }
  const calls = [], uploads = [], requests = []
  const client = {
    from(table) {
      if (table === 'user_sessions') return { select: () => ({ eq: async () => ({ data: [] }) }) }
      assert.equal(table, 'stores')
      return { select: () => ({ eq: (key, id) => {
        assert.equal(key, 'id'); assert.equal(id, ctx.storeId)
        return { single: async () => ({ data: { ...store } }) }
      } }) }
    },
    async rpc(name, args) {
      calls.push({ name, args })
      if (name === 'engine_list_branch_profiles') return { data: ctx.stores }
      return { error: null }
    },
    storage: { from: bucket => ({
      upload: async (key, file) => { uploads.push({ bucket, key, file }); return { error: null } },
      getPublicUrl: () => ({ data: { publicUrl: 'https://fixture.test/logo.png' } }),
    }) },
    auth: { getSession: async () => ({ data: { session: { access_token: 'fixture-only' } } }) },
  }
  globalThis.fetch = async (url, { method = 'GET', body } = {}) => {
    requests.push({ url, method, body: body && JSON.parse(body) })
    assert.ok((method === 'GET' && url === '/api/shipping/connections?storeId=branch-1') ||
      (method === 'POST' && url === '/api/shipping/connections'), 'unexpected network request')
    return { ok: true, json: async () => ({ connections: [] }) }
  }
  globalThis.settingsFixture = { ctx, client }
  render(createElement(Settings))
  await screen.findByDisplayValue(store.name)
  return { calls, uploads, requests, client }
}

const tab = name => screen.getByRole('tab', { name })
const button = name => screen.getByRole('button', { name })
const change = (label, value) => fireEvent.change(screen.getByLabelText(label), { target: { value } })
async function choose(trigger, label) {
  fireEvent.click(trigger)
  const option = await screen.findByRole('option', { name: label })
  await act(async () => { fireEvent.click(option) })
}

test('three tabs; the four successive branch sections submit their full draft with one final save', async () => {
  const { calls, uploads, requests } = await mount()
  assert.deepEqual(screen.getAllByRole('tab').map(t => t.textContent), ['إعدادات المحل', 'المتجر والتوصيل', 'عام'])
  const panel = within(screen.getByRole('tabpanel', { name: 'إعدادات المحل' }))
  const headings = panel.getAllByRole('heading', { level: 2 })
  assert.deepEqual(headings.map(h => h.textContent), ['إعدادات المحل · الهوية', 'تخصيص الإيصال', 'سياسات التشغيل', 'تفضيلات النظام'])
  assert.ok(panel.getByRole('link', { name: 'فتح المتجر' }).href.endsWith('/s/fixture'))
  const saves = panel.getAllByRole('button', { name: /^حفظ/ })
  assert.equal(saves.length, 1)
  const [save] = saves
  assert.equal(save.textContent, 'حفظ إعدادات الفرع')
  assert.ok(headings.at(-1).closest('section').compareDocumentPosition(save) & Node.DOCUMENT_POSITION_FOLLOWING)

  change('اسم المحل', 'اسم جديد'); change('العنوان', 'بسكرة'); change('رقم الهاتف', '0123456789')
  change('رابط الموقع (Google Maps)', 'https://example.test/map')
  const logo = new window.File(['fixture'], 'logo.png', { type: 'image/png' })
  fireEvent.change(screen.getByLabelText('شعار المحل (صورة)'), { target: { files: [logo] } })
  change('ملاحظة التذييل', 'شكراً لزيارتكم'); change('رقم الضريبة / RC', 'RC-12')
  for (const label of ['شعار المحل على الإيصال', 'أسعار الوحدات على الإيصال', 'تفعيل الباركود في نقطة البيع']) {
    fireEvent.click(screen.getByRole('checkbox', { name: label }))
  }
  await choose(button('مدة سياسة الإرجاع'), '30 يوماً')
  change('عتبة تنبيه المخزون المنخفض', '0')
  assert.equal(calls.length + uploads.length + requests.length, 0, 'ordinary edits and choosing a file do not save')
  fireEvent.click(save)
  await screen.findByText('تم حفظ إعدادات المحل')
  assert.deepEqual(calls, [{ name: 'engine_update_store_settings', args: {
    p_store: 'branch-1', p_name: 'اسم جديد', p_address: 'بسكرة', p_phone: '0123456789', p_google_maps_url: 'https://example.test/map',
    p_receipt_footer: 'شكراً لزيارتكم', p_tax_rc: 'RC-12', p_logo_on_receipt: true, p_prices_on_receipt: true,
    p_return_policy_days: 30, p_low_stock_alert: 0, p_enable_barcode: false, p_logo_url: 'https://fixture.test/logo.png',
    p_store_type: 'mens', p_theme_key: 'classic',
  } }])
  assert.equal(uploads.length, 1); assert.equal(uploads[0].bucket, 'store-logos'); assert.equal(uploads[0].file, logo)
  assert.equal(requests.length, 0)
})

test('the shared save stays disabled while pending and keeps the edited fields on rejection', async t => {
  const { client, requests } = await mount()
  let finish
  const rpc = t.mock.method(client, 'rpc', () => new Promise(resolve => { finish = resolve }))
  change('اسم المحل', 'مسودة'); change('ملاحظة التذييل', 'ملاحظة جديدة')
  fireEvent.click(button('حفظ إعدادات الفرع'))
  assert.equal(button('جاري الحفظ...').disabled, true)
  await act(async () => { finish({ error: new Error('تعذر حفظ الإعدادات التجريبية') }) })
  assert.match(screen.getByRole('alert').textContent, /تعذر حفظ الإعدادات التجريبية/)
  assert.equal(screen.getByLabelText('اسم المحل').value, 'مسودة')
  assert.equal(screen.getByLabelText('ملاحظة التذييل').value, 'ملاحظة جديدة')
  assert.equal(button('حفظ إعدادات الفرع').disabled, false)
  assert.equal(rpc.mock.callCount(), 1); assert.equal(requests.length, 0)
})

test('only the specialty and mixed-branch theme are marked and saved immediately', async () => {
  const { calls } = await mount()
  const specialty = button('تخصص الفرع')
  assert.ok(within(specialty.parentElement).getByText('يُحفظ فوراً'))
  assert.ok(!screen.queryByRole('button', { name: 'قالب المتجر الافتراضي' }))
  await choose(specialty, 'متعدد')
  const theme = await screen.findByRole('button', { name: 'قالب المتجر الافتراضي' })
  assert.ok(within(theme.parentElement).getByText('يُحفظ فوراً'))
  await choose(theme, 'القالب الأنثوي الفاخر')
  await waitFor(() => assert.ok(theme.textContent.includes('القالب الأنثوي الفاخر')))
  assert.equal(screen.getAllByText('يُحفظ فوراً').length, 2)
  assert.deepEqual(calls, ['classic', 'feminine'].map(p_theme_key => ({ name: 'engine_set_branch_specialty', args: {
    p_store: 'branch-1', p_store_type: 'mixed', p_theme_key,
  } })))
})

test('wilaya rates and each carrier have independent explicit saves on the same tab', async () => {
  const { calls, requests } = await mount()
  fireEvent.click(tab('المتجر والتوصيل'))
  await waitFor(() => assert.equal(button('تحديث').disabled, false))
  assert.equal(screen.getByRole('link', { name: 'إدارة البانرات' }).getAttribute('href'), '/dashboard/settings/banners')
  assert.equal(screen.getByRole('link', { name: 'الأقسام التحريرية' }).getAttribute('href'), '/dashboard/settings/sections')
  assert.ok(!screen.queryByRole('button', { name: 'حفظ إعدادات الفرع' }))
  assert.equal(screen.getAllByRole('button', { name: 'حفظ الإعدادات' }).length, 3)
  const courier = within(screen.getByRole('heading', { name: 'ZR Express (Procolis)' }).closest('section'))
  await choose(courier.getByRole('button', { name: 'الربط المباشر API' }), 'وضع التصدير بالجملة CSV')
  fireEvent.click(courier.getByRole('checkbox', { name: /شحن تلقائي/ }))

  const toggle = screen.getByText('عرض أسعار الولايات وتعديلها')
  fireEvent.click(toggle)
  assert.equal(screen.getAllByRole('textbox', { name: /^سعر التوصيل إلى/ }).length, 58)
  assert.equal(screen.getByLabelText('سعر التوصيل إلى بسكرة').value, '450')
  change('سعر التوصيل إلى بسكرة', '0'); change('سعر التوصيل إلى الجزائر', ''); change('سعر التوصيل إلى البليدة', '750')
  fireEvent.click(toggle)
  assert.equal(calls.length, 0); assert.ok(requests.every(r => r.method === 'GET'))
  fireEvent.click(button('حفظ أسعار التوصيل'))
  await screen.findByText('تم حفظ أسعار التوصيل')
  assert.deepEqual(calls, [{ name: 'engine_update_delivery_rates', args: { p_store: 'branch-1', p_rates: { '07': 0, '09': 750 } } }])
  assert.ok(requests.every(r => r.method === 'GET'), 'saving rates did not save the edited carrier')

  fireEvent.click(courier.getByRole('button', { name: 'حفظ الإعدادات' }))
  await screen.findByText(/تم حفظ إعدادات ZR Express/)
  assert.deepEqual(requests.filter(r => r.method !== 'GET'), [{ url: '/api/shipping/connections', method: 'POST', body: {
    storeId: 'branch-1', providerCode: 'zrexpress', environment: 'sandbox', mode: 'bulk', enabled: true,
    originWilayaCode: null, defaults: { deliveryType: 'home', autoShip: true, stopDeskId: '' },
  } }])
  assert.equal(calls.length, 1, 'saving a carrier did not submit rates or branch settings')
})

test('employees still see the carrier restriction and their original General actions', async () => {
  const { calls, requests } = await mount('employee')
  fireEvent.keyDown(tab('إعدادات المحل'), { key: 'ArrowLeft' })
  assert.equal(tab('المتجر والتوصيل').getAttribute('aria-selected'), 'true')
  screen.getByText(/إعدادات الربط متاحة للمالك أو المدير فقط/)
  assert.ok(!screen.queryByRole('link', { name: 'إدارة البانرات' }))
  assert.ok(!screen.queryByRole('link', { name: 'الأقسام التحريرية' }))
  assert.ok(!screen.queryByRole('button', { name: 'حفظ الإعدادات' }))
  fireEvent.click(tab('عام'))
  screen.getByText('إدارة الاشتراك متاحة للمالك فقط.')
  button('إعادة محاولة المزامنة'); button('تسجيل الخروج')
  assert.ok(!screen.queryByRole('button', { name: 'إضافة فرع' }))
  assert.ok(!screen.queryByRole('button', { name: 'تصدير المبيعات CSV' }))
  assert.equal(calls.length + requests.length, 0)
})
