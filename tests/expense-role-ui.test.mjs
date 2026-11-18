// Render the real expense tab and top bar. Only session, storage/RPC and formatting
// boundaries are replaced; no Supabase URL or credentials are used.
import test, { afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID as uuid } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import path from 'node:path'
import { build } from 'esbuild'
import { JSDOM } from 'jsdom'

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://local.test/dashboard/operations' })
for (const key of ['window','document','HTMLElement','Node','MutationObserver','Event']) globalThis[key] = dom.window[key]
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: dom.window.navigator })
globalThis.IS_REACT_ACT_ENVIRONMENT = true
window.open = () => null
const { createElement } = await import('react')
const { render, screen, fireEvent, within, waitFor, cleanup } = await import('@testing-library/react')
afterEach(cleanup)

const outfile = path.resolve('.cache/expense-role-ui/screens.mjs')
await build({
  stdin: { contents: `export { default as Page } from './app/dashboard/_screens/expenses.js';
    export { default as TopBarButton } from './components/dashboard/ExpenseButton.js';`, resolveDir: process.cwd() },
  outfile, bundle: true, platform: 'node', format: 'esm', jsx: 'automatic', loader: { '.js': 'jsx' },
  external: ['react', 'react/*', 'react-dom', 'react-dom/*'],
  plugins: [{ name: 'expense-boundaries', setup(b) {
    const stubs = {
      SessionProvider: 'export const useDashboardSession = () => globalThis.expenseFixture.ctx',
      supabase: 'export const supabase = new Proxy({}, {get: (_, key) => globalThis.expenseFixture.client[key]})',
      'app-context': 'export const formatDzd = String',
    }
    b.onResolve({ filter: /\/(SessionProvider|supabase|app-context)$/ }, args => ({ path: path.basename(args.path), namespace: 'expense-test' }))
    b.onLoad({ filter: /.*/, namespace: 'expense-test' }, args => ({ contents: stubs[args.path] }))
  } }],
})
const { Page, TopBarButton } = await import(pathToFileURL(outfile))
const pdf = () => new dom.window.File(['test'], 'ticket.pdf', { type: 'application/pdf' })

function fixture(role, { all = false, failOnce = false } = {}) {
  const tenantId = uuid(), store = uuid(), sibling = uuid()
  const ctx = { role, tenantId, user: { id: uuid() }, staffId: uuid(), assignedStoreId: store, storeId: all ? null : store,
    stores: [{ id: store, name: 'الأول' }, { id: sibling, name: 'الثاني' }] }
  const rpc = [], uploads = [], signs = [], rows = []
  const client = {
    from: table => {
      assert.equal(table, 'expenses')
      const q = { range: async () => ({ data: rows }) }
      for (const op of ['select','eq','is','order']) q[op] = () => q
      return q
    },
    rpc: async (name, args) => {
      rpc.push({ name, args })
      if (failOnce) { failOnce = false; return { error: new Error('ردّ غير مؤكد') } }
      return { error: null }
    },
    storage: { from: bucket => ({
      upload: async (key, file, options) => { uploads.push({ bucket, key, file, options }); return { error: null } },
      createSignedUrl: async (key, seconds) => { signs.push({ bucket, key, seconds }); return { data: { signedUrl: 'about:blank' } } },
    }) },
  }
  globalThis.expenseFixture = { ctx, client }
  return { ctx, rpc, uploads, signs, rows, sibling }
}
async function openTabForm() {
  render(createElement(Page))
  await screen.findByText('لا توجد مصاريف مسجلة.')
  fireEvent.click(screen.getByRole('button', { name: 'إضافة مصروف' }))
  const form = within(screen.getByRole('dialog'))
  fireEvent.change(form.getByLabelText('المبلغ'), { target: { value: '125' } })
  fireEvent.change(form.getByLabelText('الوصف'), { target: { value: '  مصروف اليوم  ' } })
  await choose('التصنيف', 'صيانة')
  return form
}
async function choose(label, choice) {
  fireEvent.click(screen.getByRole('button', { name: label }))
  fireEvent.click(await screen.findByRole('option', { name: choice }))
}
const save = form => fireEvent.click(form.getByRole('button', { name: 'حفظ المصروف' }))
const attach = (form, file) => fireEvent.change(form.getByLabelText(/إيصال/), { target: { files: [file] } })

for (const role of ['employee', 'manager', 'owner']) {
  test(`tab: ${role} sends the selected category, receipt and branch through the correct RPC`, async () => {
    const { ctx, uploads, rpc, sibling } = fixture(role, { all: role === 'owner', failOnce: role === 'employee' })
    const form = await openTabForm()
    const file = pdf()
    attach(form, file)
    if (role === 'owner') {
      save(form)
      assert.match(form.getByRole('alert').textContent, /اختر فرعاً/)
      assert.equal(uploads.length + rpc.length, 0)
      await choose('الفرع', 'الثاني')
    } else assert.equal(form.queryByRole('button', { name: 'الفرع' }), null)
    save(form)
    if (role === 'employee') {
      await form.findByText('ردّ غير مؤكد')
      save(form) // same actor, request and receipt; no fallback to v2
    }
    await screen.findByText('تم تسجيل المصروف')
    assert.equal(uploads.length, 1)
    const staff = role === 'employee', selected = role === 'owner' ? sibling : ctx.storeId
    const { name, args } = rpc[0]
    assert.equal(rpc.length, staff ? 2 : 1)
    if (staff) assert.deepEqual(rpc[1], rpc[0])
    assert.equal(name, staff ? 'engine_record_expense_for_staff' : 'engine_record_expense_v2')
    assert.deepEqual(args, { p_store: selected, p_amount: 125, p_category: 'صيانة', p_description: 'مصروف اليوم',
      p_receipt: uploads[0].key, p_request: args.p_request, ...(staff ? { p_staff: ctx.staffId } : {}) })
    assert.equal(uploads[0].bucket, staff ? 'expense-receipts' : 'receipts')
    assert.deepEqual(uploads[0].options, { upsert: false, contentType: file.type })
    if (staff) assert.equal(args.p_receipt, `${ctx.tenantId}/${selected}/${ctx.user.id}/${args.p_request}.pdf`)
    else assert.match(args.p_receipt, new RegExp(`^${ctx.tenantId}/${selected}/[0-9]+-${args.p_request}\\.pdf$`))
  })
}

test('employee: rejects an empty file before upload and can still save without a receipt', async () => {
  const { uploads, rpc } = fixture('employee')
  const form = await openTabForm()
  attach(form, new dom.window.File([], 'empty.pdf', { type: 'application/pdf' }))
  save(form)
  assert.match((await form.findByRole('alert')).textContent, /الإيصال/)
  fireEvent.change(form.getByLabelText(/إيصال/), { target: { files: [] } })
  save(form)
  await screen.findByText('تم تسجيل المصروف')
  assert.equal(uploads.length, 0)
  assert.equal(rpc.length, 1)
  assert.equal(rpc[0].name, 'engine_record_expense_for_staff')
  assert.equal(rpc[0].args.p_receipt, null)
})

test('reading mixed history chooses the row’s bucket, not the viewer’s role', async () => {
  const { ctx, signs, rows } = fixture('owner')
  const prefix = `${ctx.tenantId}/${ctx.storeId}`
  const paths = [`${prefix}/${uuid()}/${uuid()}.jpg`, `${prefix}/legacy.pdf`]
  for (const p of paths) rows.push({ id: uuid(), store_id: ctx.storeId, receipt_url: p, amount: 10 })
  render(createElement(Page))
  for (const button of await screen.findAllByRole('button', { name: 'عرض' })) fireEvent.click(button)
  await waitFor(() => assert.deepEqual(signs, paths.map((key, i) => ({ key, bucket: i ? 'receipts' : 'expense-receipts', seconds: 60 }))))
})

test('unchanged top bar still submits the six named staff arguments', async () => {
  const { ctx, rpc } = fixture('employee')
  render(createElement(TopBarButton))
  fireEvent.click(screen.getByRole('button', { name: 'تسجيل مصروف' }))
  const form = within(screen.getByRole('dialog'))
  fireEvent.change(form.getByLabelText('المبلغ (دج)'), { target: { value: '75' } })
  fireEvent.change(form.getByLabelText('الوصف'), { target: { value: 'مصروف' } })
  save(form)
  await screen.findByText('تم تسجيل المصروف')
  assert.equal(rpc.length, 1)
  assert.deepEqual(rpc[0], { name: 'engine_record_expense_for_staff', args: {
    p_staff: ctx.staffId, p_store: ctx.storeId, p_amount: 75, p_description: 'مصروف', p_receipt: null, p_request: rpc[0].args.p_request,
  } })
})
