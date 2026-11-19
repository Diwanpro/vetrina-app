import test, { afterEach } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { JSDOM } from 'jsdom'
const dom = new JSDOM('<html dir="rtl"><body></body></html>', { url: 'https://shop.test', pretendToBeVisual: true })
for (const k of ['window', 'document', 'HTMLElement', 'Node', 'Event', 'MutationObserver']) globalThis[k] = dom.window[k]
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: dom.window.navigator })
globalThis.IS_REACT_ACT_ENVIRONMENT = true
const { createElement: h } = await import('react')
const { render, screen, within, fireEvent, waitFor, act, cleanup } = await import('@testing-library/react')
const outfile = path.resolve('.cache/storefront-content-ui/page.mjs')
await build({ entryPoints: ['components/store/Storefront.js'], outfile, bundle: true, platform: 'node', format: 'esm', jsx: 'automatic', loader: { '.js': 'jsx' }, external: ['react', 'react/*', 'react-dom', 'react-dom/*'], plugins: [{ name: 'public-session-fixture', setup(b) {
  b.onResolve({ filter: /^@\/lib\/supabase$/ }, () => ({ path: 'client', namespace: 'fixture' }))
  b.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: 'export const supabase={rpc:(...a)=>globalThis.shop.rpc(...a),channel:()=>({on(){return this},subscribe(){return this}}),removeChannel(){}}' }))
} }] })
const { default: Storefront } = await import(pathToFileURL(outfile))
const actualFetch = globalThis.fetch
const empty = { banners: [], sections: [] }
const item = (id, href = null) => ({ id, title: `مختارات ${id}`, imageUrl: `https://images.test/${id}.png?token=test`, href })
function deferred() { let resolve; const promise = new Promise(r => { resolve = r }); return { promise, resolve } }
function mount(content = empty, type = 'mens') {
  const calls = [], store = { slug: 'myshop', store_id: 'branch', name: 'متجر الاختبار', store_type: type, accepts_orders: true }
  globalThis.shop = { rpc: async (fn) => ({ data: fn === 'get_store_by_slug' ? { ...store } : [], error: null }) }
  globalThis.fetch = async (url, init) => { calls.push({ url, init }); return content instanceof Promise ? content : Response.json(content) }
  const view = render(h(Storefront, { slug: 'myshop' }))
  return { ...view, calls, store }
}
afterEach(() => { cleanup(); globalThis.fetch = actualFetch; delete globalThis.shop })
async function ready() { await screen.findByRole('heading', { name: 'متجر الاختبار', level: 1 }); await waitFor(() => assert.ok(document.querySelector('.sf-grid'))) }
const categories = () => within(screen.getByRole('navigation', { name: 'أقسام المتجر' }))

test('empty store keeps the original hero, categories and browsable products', async () => {
  const f = mount(); await ready(); await waitFor(() => assert.equal(f.calls.length, 1))
  assert.ok(screen.getByText('تسوّق من متجر الاختبار'))
  fireEvent.click(categories().getByRole('button', { name: 'ملابس' }))
  assert.ok(document.querySelectorAll('.sf-grid article').length > 0)
  assert.equal(categories().getByRole('button', { name: 'ملابس' }).getAttribute('aria-current'), 'page')
  assert.equal(f.calls[0].url, '/api/store/myshop/content'); assert.equal(f.calls[0].init.cache, 'no-store'); assert.equal(f.calls[0].init.credentials, 'omit')
})

test('a pending content request cannot delay the product grid or category navigation', async () => {
  const d = deferred(); mount(d.promise); await ready()
  fireEvent.click(categories().getByRole('button', { name: 'ملابس' }))
  assert.ok(document.querySelectorAll('.sf-grid article').length > 0)
  await act(async () => d.resolve(Response.json({ banners: [], sections: [item('section', '/collection')] })))
  await screen.findByRole('heading', { name: 'اكتشف الأقسام' })
  assert.equal(categories().queryByRole('button', { name: 'ملابس' }), null)
  assert.equal(categories().getByRole('button', { name: 'الكل' }).getAttribute('aria-current'), 'page')
  assert.ok(document.querySelectorAll('.sf-grid article').length > 1)
})

for (const type of ['mens', 'womens']) test(`${type}: banners and editorial cards inherit the branch theme; links are not product filters`, async () => {
  mount({ banners: [item('banner', '/sale'), item('next')], sections: [item('section', 'https://example.test/collection')] }, type)
  await screen.findByRole('region', { name: 'بانرات المتجر' }); await ready()
  assert.ok(document.querySelector(`[data-store-theme="${type === 'mens' ? 'masculine' : 'feminine'}"] .sf-card`))
  assert.equal(screen.getByRole('link', { name: 'مختارات section' }).getAttribute('href'), 'https://example.test/collection')
  assert.equal(categories().queryByRole('button', { name: 'مختارات section' }), null)
  assert.equal(screen.queryByText('تسوّق من متجر الاختبار'), null)
  fireEvent.click(screen.getByRole('button', { name: 'البانر التالي' })); assert.ok(screen.getByRole('heading', { name: 'مختارات next' }))
})

for (const surface of ['banners', 'sections']) test(`independent ${surface} fallback after a broken image leaves other content and products intact`, async () => {
  const b = item('banner'), s = item('section'); mount({ banners: [b], sections: [s] }); await ready()
  await screen.findByRole('heading', { name: 'مختارات section' })
  const target = surface === 'banners' ? b : s
  fireEvent.error([...document.querySelectorAll('img')].find(img => img.src === target.imageUrl))
  if (surface === 'banners') { assert.ok(screen.getByText('تسوّق من متجر الاختبار')); assert.ok(screen.getByRole('heading', { name: s.title })) }
  else { assert.ok(categories().getByRole('button', { name: 'ملابس' })); assert.ok(screen.getByRole('heading', { name: b.title })) }
  assert.ok(document.querySelectorAll('.sf-grid article').length > 0)
})

test('HTTP failure falls back without showing a catalog error', async () => {
  mount(Promise.resolve(new Response('', { status: 503 }))); await ready()
  assert.ok(screen.getByText('تسوّق من متجر الاختبار')); assert.ok(categories().getByRole('button', { name: 'ملابس' }))
  assert.equal(screen.queryByText('تعذر فتح المتجر'), null)
})

test('profile refresh does not renew content; an obsolete slug response is ignored', async () => {
  const d = deferred(), f = mount(d.promise); await ready(); assert.equal(f.calls.length, 1)
  await act(async () => window.dispatchEvent(new Event('focus')))
  assert.equal(f.calls.length, 1)
  f.rerender(h(Storefront, { slug: 'another-shop' }))
  await act(async () => d.resolve(Response.json({ banners: [item('obsolete')], sections: [] })))
  assert.equal(screen.queryByRole('heading', { name: 'مختارات obsolete' }), null)
})

test('expired signatures renew on foreground, while a fresh signature does not refetch', async () => {
  const f = mount({ banners: [item('first')], sections: [] }); await ready()
  await screen.findByRole('heading', { name: 'مختارات first' })
  await act(async () => document.dispatchEvent(new Event('visibilitychange')))
  assert.equal(f.calls.length, 1)
  const now = Date.now
  try {
    Date.now = () => now() + 5 * 60 * 1000
    await act(async () => document.dispatchEvent(new Event('visibilitychange')))
    assert.equal(f.calls.length, 2)
  } finally { Date.now = now }
})
