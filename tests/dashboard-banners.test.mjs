// The real page, editor, PostgREST and Storage clients. Only HTTP, session and shell are fixtures.
import test, { afterEach } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { createClient } from '@supabase/supabase-js'
import { JSDOM } from 'jsdom'

const route = '/dashboard/settings/banners'
const dom = new JSDOM('<html dir="rtl"><body></body></html>', { url: `https://local.test${route}?storeId=untrusted`, pretendToBeVisual: true })
for (const k of ['window', 'document', 'HTMLElement', 'Node', 'Event', 'MutationObserver']) globalThis[k] = dom.window[k]
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: dom.window.navigator })
globalThis.IS_REACT_ACT_ENVIRONMENT = true
const { createElement } = await import('react')
const { act, render, screen, within, waitFor, fireEvent, cleanup } = await import('@testing-library/react')
const stubs = {
  '@/components/dashboard/DashboardShell': 'export default ({children})=>children',
  '@/components/dashboard/SessionProvider': 'export const useDashboardSession=()=>globalThis.bannerFixture.ctx',
  '@/lib/supabase': 'export const supabase={from:(...args)=>globalThis.bannerFixture.client.from(...args),get storage(){return globalThis.bannerFixture.client.storage}}',
}
const outfile = path.resolve('.cache/dashboard-banners/page.mjs')
await build({ stdin: { contents: `export {default as Page} from './app/dashboard/settings/banners/page'; export {routeAllowed} from './lib/access'`, resolveDir: process.cwd() },
  outfile, bundle: true, platform: 'node', format: 'esm', jsx: 'automatic', loader: { '.js': 'jsx' }, external: ['react', 'react/*', 'react-dom', 'react-dom/*'],
  plugins: [{ name: 'page-fixture', setup(b) {
    b.onResolve({ filter: /^@\// }, ({ path }) => Object.hasOwn(stubs, path) ? { path, namespace: 'stub' } : undefined)
    b.onLoad({ filter: /.*/, namespace: 'stub' }, ({ path }) => ({ contents: stubs[path] }))
  } }],
})
const { Page, routeAllowed } = await import(pathToFileURL(outfile))
const id = n => `00000000-0000-4000-b000-${String(n).padStart(12, '0')}`
const tenant = id(1), branch = id(2), sibling = id(3), foreign = id(4)
const dir = `${tenant}/${branch}/`, table = '/rest/v1/storefront_banners', bucket = '/storage/v1/object/storefront-assets', sign = '/storage/v1/object/sign/storefront-assets'
const stores = [{ id: branch, name: 'فرع بسكرة' }, { id: sibling, name: 'الفرع الثاني' }]
const row = (n, overrides = {}) => ({ id: id(n), tenant_id: tenant, store_id: branch, title: `بانر ${n}`, image_url: `${dir}${n}.png`, link_url: null, sort_order: n, status: 'draft', ...overrides })
const seeds = () => [row(11), row(10, { status: 'published' }), row(12, { store_id: sibling, image_url: `${tenant}/${sibling}/12.png` }), row(13, { tenant_id: foreign })]
const errorReply = (status, code) => Response.json({ code, message: 'fixture error' }, { status })
function deferred() { let resolve; const promise = new Promise(r => { resolve = r }); return { promise, resolve } }
function mount({ role = 'manager', ctx = {}, banners = seeds(), intercept } = {}) {
  const f = { calls: [], unexpected: [], ctx: { role, user: { id: id(8) }, tenantId: tenant, storeId: branch, assignedStoreId: branch, stores, ...ctx } }
  let gen = 0
  f.client = createClient('https://fixture.test', 'local-only', { accessToken: async () => 'fixture', global: { fetch: async (input, init) => {
    const { pathname, searchParams: params } = new URL(input), method = init.method
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : init.body
    const c = { method, pathname, params, body, headers: new Headers(init.headers) }; f.calls.push(c)
    const reply = await intercept?.(c); if (reply) return reply
    if (pathname === table) {
      const matching = banners.filter(r => ['tenant_id', 'store_id', 'id'].every(k => !params.has(k) || params.get(k) === `eq.${r[k]}`))
      if (method === 'GET') {
        const start = Number(params.get('offset') || 0)
        return Response.json(matching.sort((a, b) => a.sort_order - b.sort_order || a.id.localeCompare(b.id)).slice(start, start + Number(params.get('limit') || 1000)))
      }
      if (method === 'POST') { const id = crypto.randomUUID(); banners.push({ ...body, id }); return Response.json([{ id }], { status: 201 }) }
      if (method === 'PATCH') { for (const r of matching) Object.assign(r, body); return Response.json(matching.map(({ id }) => ({ id }))) }
    }
    if (pathname === sign && method === 'POST') {
      gen++; return Response.json(body.paths.map(key => ({ path: key, error: null, signedURL: `/object/sign/storefront-assets/${key}?token=fixture-${gen}` })))
    }
    if (pathname.startsWith(bucket + '/') && method === 'POST') return Response.json({ Id: id(99), Key: pathname })
    if (pathname === bucket && method === 'DELETE') return Response.json([])
    f.unexpected.push(`${method} ${pathname}`); return errorReply(400, 'unexpected')
  } } })
  globalThis.bannerFixture = f
  const view = render(createElement(Page))
  f.switchContext = patch => { f.ctx = { ...f.ctx, ...patch }; view.rerender(createElement(Page)) }
  f.reads = () => f.calls.filter(c => c.pathname === table && c.method === 'GET')
  f.writes = () => f.calls.filter(c => c.pathname === table && c.method !== 'GET')
  f.uploads = () => f.calls.filter(c => c.pathname.startsWith(bucket + '/'))
  f.signs = () => f.calls.filter(c => c.pathname === sign)
  return f
}
afterEach(() => { cleanup(); assert.deepEqual(globalThis.bannerFixture?.unexpected || [], []); delete globalThis.bannerFixture })
const btn = name => screen.getByRole('button', { name })
const openNew = () => fireEvent.click(btn('إضافة بانر جديد'))
const editFirst = async () => fireEvent.click(await screen.findByRole('button', { name: 'تعديل بانر بانر 10' }))
const change = (name, value) => fireEvent.change(screen.getByLabelText(name), { target: { value } })
const upload = file => fireEvent.change(screen.getByLabelText('صورة البانر'), { target: { files: [file] } })
const image = () => new File(['fixture'], 'اختبار/الأصل.gif', { type: 'image/webp' })
const save = () => fireEvent.click(btn('حفظ البانر'))
const paths = f => f.signs().flatMap(c => c.body.paths)
const scope = c => {
  assert.equal(c.params.get('tenant_id'), `eq.${tenant}`); assert.equal(c.params.get('store_id'), `eq.${branch}`)
}

for (const role of ['owner', 'manager']) test(`${role}: list is sorted and scoped in PostgREST, only current-branch images are signed`, async () => {
  const f = mount({ role })
  assert.ok(routeAllowed(role, route)); await screen.findByRole('img', { name: 'صورة بانر 10' })
  assert.deepEqual(screen.getAllByRole('heading', { level: 3 }).map(h => h.textContent), ['بانر 10', 'بانر 11'])
  for (const [n, label] of [[10, 'منشور'], [11, 'مسودة']]) {
    const card = within(screen.getByText(`بانر ${n}`).closest('li')); card.getByText(label); card.getByText(`الترتيب: ${n}`)
  }
  f.reads().forEach(scope); assert.equal(f.reads()[0].params.get('order'), 'sort_order.asc,id.asc')
  assert.equal(f.signs()[0].body.expiresIn, 300); assert.deepEqual(paths(f), [`${dir}10.png`, `${dir}11.png`]); assert.equal(f.writes().length, 0)
})
for (const [name, role, ctx] of [['employee', 'employee', {}], ['visitor', 'guest', {}], ['all branches', 'owner', { allBranches: true }],
  ['no user', 'owner', { user: null }], ['no tenant', 'owner', { tenantId: null }], ['unlisted branch', 'owner', { storeId: 'other' }], ['wrong assignment', 'manager', { storeId: sibling }], ['offline', 'owner', { offline: true }]]) {
  test(`direct URL: ${name} cannot load, sign or open the editor`, () => {
    const f = mount({ role, ctx }); if (['employee', 'guest'].includes(role)) assert.equal(routeAllowed(role, route), false)
    screen.getByRole('alert'); assert.ok(!screen.queryByRole('button')); assert.deepEqual(f.calls, [])
  })
}

test('new banner: upload on save only, generated branch key, persisted draft and no signed/public URL in row', async () => {
  const f = mount({ banners: [] }); await screen.findByText('لا توجد بانرات لهذا الفرع بعد.'); openNew()
  assert.ok(screen.getByRole('radio', { name: 'مسودة' }).checked)
  change('عنوان البانر', ' عرض جديد '); change('الترتيب', '3'); upload(image())
  assert.ok(screen.getByAltText('معاينة صورة البانر').src.startsWith('blob:')); assert.equal(f.uploads().length, 0); save()
  await screen.findByText('تمت إضافة البانر.'); const thumb = await screen.findByAltText('صورة عرض جديد')
  const [up] = f.uploads(), key = up.pathname.slice(bucket.length + 1)
  assert.equal(f.uploads().length, 1); assert.match(key.slice(dir.length), /^[0-9a-f-]{36}\.webp$/); assert.ok(key.startsWith(dir)); assert.equal(up.headers.get('x-upsert'), 'false')
  assert.deepEqual(f.writes().map(c => c.body), [{ tenant_id: tenant, store_id: branch, title: 'عرض جديد', sort_order: 3, status: 'draft', link_url: null, image_url: key }])
  assert.ok(thumb.src.includes(`/object/sign/storefront-assets/${key}?token=`)); assert.deepEqual(paths(f), [key])
})
test('editor uses and renews a signed preview; editing without a file preserves the key, updates only the matching id/tenant/store', async () => {
  const f = mount(); const old = (await screen.findByAltText('صورة بانر 10')).src; await editFirst()
  assert.equal(screen.getByAltText('معاينة صورة البانر').src, old)
  await act(async () => document.dispatchEvent(new Event('visibilitychange')))
  await waitFor(() => assert.notEqual(screen.getByAltText('معاينة صورة البانر').src, old))
  change('عنوان البانر', 'بعد التعديل'); change('الرابط (اختياري)', '/s/branch'); change('الترتيب', '0'); fireEvent.click(screen.getByRole('radio', { name: 'مسودة' })); save()
  await screen.findByText('تم تحديث البانر.'); await screen.findByText('بعد التعديل'); const [c] = f.writes(); scope(c)
  assert.equal(c.method, 'PATCH'); assert.equal(c.params.get('id'), `eq.${id(10)}`); assert.deepEqual(c.body, { title: 'بعد التعديل', status: 'draft', link_url: '/s/branch', sort_order: 0 }); assert.equal(f.uploads().length, 0)
})
test('replacing an image is local until saved; cancel is side-effect free and a confirmed edit signs the new key', async () => {
  const f = mount(); await screen.findByAltText('صورة بانر 10'); await editFirst(); upload(image()); fireEvent.click(btn('إلغاء'))
  assert.ok(!screen.queryByRole('dialog')); assert.equal(f.uploads().length, 0); assert.equal(f.writes().length, 0)
  await editFirst(); assert.ok(screen.getByAltText('معاينة صورة البانر').src.includes(`${dir}10.png?token=`)); upload(image()); save()
  await screen.findByText('تم تحديث البانر.'); const [write] = f.writes(), newKey = f.uploads()[0].pathname.slice(bucket.length + 1)
  scope(write); assert.equal(write.params.get('id'), `eq.${id(10)}`); assert.equal(write.body.image_url, newKey); assert.ok(newKey.startsWith(dir) && newKey.endsWith('.webp'))
  await waitFor(() => assert.ok(screen.getByAltText('صورة بانر 10').src.includes(`${newKey}?token=`)))
  assert.equal(f.calls.filter(c => c.method === 'DELETE').length, 0, 'the old object could be referenced elsewhere')
})
test('editor validates title, required image, MIME, size, link and integer order before uploading', async () => {
  const f = mount(); await screen.findByText('بانر 10'); openNew(); save(); await screen.findByText('أدخل عنوان البانر.'); change('عنوان البانر', 'جديد'); save(); await screen.findByText('اختر صورة للبانر.')
  upload(new File(['x'], 'x.png', { type: 'image/svg+xml' })); assert.match(screen.getByRole('alert').textContent, /JPEG/)
  const large = image(); Object.defineProperty(large, 'size', { value: 8388609 }); upload(large); assert.match(screen.getByRole('alert').textContent, /8/); upload(image())
  for (const value of ['//untrusted.test', 'javascript:alert(1)', '/\\outside', 'https:///invalid']) {
    change('الرابط (اختياري)', value); save(); await screen.findByText(/أدخل رابط HTTP/)
  }
  change('الرابط (اختياري)', 'https://example.test/banner'); change('الترتيب', '-1'); save(); await screen.findByText(/أدخل ترتيباً صحيحاً/)
  assert.equal(f.uploads().length, 0); assert.equal(f.writes().length, 0); change('الترتيب', '4'); fireEvent.click(screen.getByRole('radio', { name: 'منشور' })); save()
  await screen.findByText('تمت إضافة البانر.'); assert.equal(f.writes()[0].body.link_url, 'https://example.test/banner'); assert.equal(f.writes()[0].body.status, 'published')
})
test('upload failure does not write metadata, close the editor, or discard the existing asset', async () => {
  const f = mount({ intercept: c => c.pathname.startsWith(bucket + '/') && errorReply(403, 'denied') }); await editFirst(); upload(image()); save()
  await screen.findByText(/تعذر رفع الصورة/); screen.getByRole('dialog'); assert.equal(f.writes().length, 0); assert.equal(f.calls.filter(c => c.method === 'DELETE').length, 0)
})
test('a definite DB rejection cleans up only the newly uploaded key; zero matched rows never report success', async () => {
  let empty = false
  const f = mount({ intercept: c => c.method === 'PATCH' && (empty ? Response.json([]) : errorReply(403, '42501')) }); await editFirst(); upload(image()); save()
  await screen.findByText(/تعذر حفظ البانر/); const [up] = f.uploads(); const [removal] = f.calls.filter(c => c.method === 'DELETE'); assert.deepEqual(removal.body.prefixes, [up.pathname.slice(bucket.length + 1)])
  empty = true; save(); await screen.findByText(/لم يعد البانر متاحاً/); assert.ok(!screen.queryByText('تم تحديث البانر.'))
})
test('unconfirmed insert blocks repeat submit, retains the potentially committed object, and refreshes on close', async () => {
  const gate = deferred(), f = mount({ banners: [], intercept: c => c.pathname === table && c.method === 'POST' && gate.promise })
  await screen.findByText(/لا توجد بانرات لهذا الفرع/); openNew(); change('عنوان البانر', 'جديد'); upload(image()); save()
  assert.ok(btn('جاري الحفظ…').disabled); fireEvent.keyDown(window, { key: 'Escape' }); screen.getByRole('dialog')
  await act(async () => gate.resolve(errorReply(503, 'unconfirmed'))); await screen.findByText(/تعذر تأكيد الحفظ/); assert.ok(btn('حفظ البانر').disabled)
  assert.equal(f.writes().length, 1); assert.equal(f.calls.filter(c => c.method === 'DELETE').length, 0); fireEvent.click(btn('العودة إلى القائمة')); await screen.findByText(/لا توجد بانرات لهذا الفرع/); assert.equal(f.reads().length, 2)
})
test('changing branch during an upload unmounts the draft and does not issue a stale row write', async () => {
  const gate = deferred(), f = mount({ role: 'owner', intercept: c => c.pathname.startsWith(bucket + '/') && gate.promise }); await editFirst(); upload(image()); save()
  await waitFor(() => assert.equal(f.uploads().length, 1)); f.switchContext({ storeId: sibling }); await screen.findByText('بانر 12'); assert.ok(!screen.queryByRole('dialog'))
  await act(async () => gate.resolve(Response.json({ Id: id(99), Key: 'fixture' }))); assert.equal(f.writes().length, 0); assert.ok(!screen.queryByText('بانر 10')); assert.equal(f.reads().at(-1).params.get('store_id'), `eq.${sibling}`)
})
test('never signs an external URL or foreign branch key; missing previews do not prevent editing metadata', async () => {
  const f = mount({ banners: [row(10, { image_url: 'https://example.test/photo.jpg' }), row(11, { image_url: `${tenant}/${sibling}/wrong.png` }), row(12)], intercept: c => c.pathname === sign && errorReply(403, 'denied') })
  await screen.findByText('بانر 10'); await waitFor(() => assert.deepEqual(paths(f), [`${dir}12.png`])); assert.ok(!screen.queryByRole('img')); fireEvent.click(btn('تعديل بانر بانر 12')); change('عنوان البانر', 'عنوان'); save(); await screen.findByText('تم تحديث البانر.')
})
test('scoped pagination signs only visible rows, not the lookahead row', async () => {
  const f = mount({ banners: Array.from({ length: 21 }, (_, i) => row(100 + i)) }); await screen.findByAltText('صورة بانر 100'); assert.equal(f.signs()[0].body.paths.length, 20); assert.ok(!screen.queryByText('بانر 120'))
  fireEvent.click(btn('التالي')); await screen.findByAltText('صورة بانر 120'); assert.deepEqual(f.signs()[1].body.paths, [`${dir}120.png`]); assert.ok(btn('التالي').disabled)
  f.reads().forEach(scope); assert.equal(f.reads()[1].params.get('offset'), '20'); fireEvent.click(btn('السابق')); await screen.findByText('بانر 100')
})
