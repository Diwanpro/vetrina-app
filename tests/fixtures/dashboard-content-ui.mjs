// The real page, editor, PostgREST and Storage clients. Only HTTP, session and shell are fixtures.
import { afterEach } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { createClient } from '@supabase/supabase-js'
import { JSDOM } from 'jsdom'

const dom = new JSDOM('<html dir="rtl"><body></body></html>', { url: 'https://local.test', pretendToBeVisual: true })
for (const k of ['window', 'document', 'HTMLElement', 'Node', 'Event', 'MutationObserver']) globalThis[k] = dom.window[k]
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: dom.window.navigator })
globalThis.IS_REACT_ACT_ENVIRONMENT = true
const { createElement } = await import('react')
const { act, render, screen, within, waitFor, fireEvent, cleanup } = await import('@testing-library/react')
export { act, screen, within, waitFor, fireEvent }
const stubs = {
  '@/components/dashboard/DashboardShell': 'export default ({children})=>children',
  '@/components/dashboard/SessionProvider': 'export const useDashboardSession=()=>globalThis.contentFixture.ctx',
  '@/lib/supabase': 'export const supabase={from:(...args)=>globalThis.contentFixture.client.from(...args),get storage(){return globalThis.contentFixture.client.storage}}',
}
export const id = n => `00000000-0000-4000-b000-${String(n).padStart(12, '0')}`
export const tenant = id(1), branch = id(2), sibling = id(3), foreign = id(4)
export const dir = `${tenant}/${branch}/`, bucket = '/storage/v1/object/storefront-assets', sign = '/storage/v1/object/sign/storefront-assets'
const stores = [{ id: branch, name: 'فرع بسكرة' }, { id: sibling, name: 'الفرع الثاني' }]
export const errorReply = (status, code) => Response.json({ code, message: 'fixture error' }, { status })
export function deferred() { let resolve; const promise = new Promise(r => { resolve = r }); return { promise, resolve } }
afterEach(() => { cleanup(); assert.deepEqual(globalThis.contentFixture?.unexpected || [], []); delete globalThis.contentFixture })

// The mock serves exactly one content table. An accidental read/write to another
// table (including the other editor's table) is a test failure, not an empty list.
export async function dashboardContentFixture(slug, tableName, noun) {
  const route = `/dashboard/settings/${slug}`, table = `/rest/v1/${tableName}`
  window.history.replaceState(null, '', `${route}?storeId=untrusted`)
  const outfile = path.resolve(`.cache/dashboard-${slug}/page.mjs`)
  await build({ stdin: { contents: `export {default as Page} from './app/dashboard/settings/${slug}/page'; export {routeAllowed} from './lib/access'`, resolveDir: process.cwd() },
    outfile, bundle: true, platform: 'node', format: 'esm', jsx: 'automatic', loader: { '.js': 'jsx' }, external: ['react', 'react/*', 'react-dom', 'react-dom/*'],
    plugins: [{ name: 'page-fixture', setup(b) {
      b.onResolve({ filter: /^@\// }, ({ path }) => Object.hasOwn(stubs, path) ? { path, namespace: 'stub' } : undefined)
      b.onLoad({ filter: /.*/, namespace: 'stub' }, ({ path }) => ({ contents: stubs[path] }))
    } }],
  })
  const { Page, routeAllowed } = await import(pathToFileURL(outfile))
  const row = (n, overrides = {}) => ({ id: id(n), tenant_id: tenant, store_id: branch, title: `${noun} ${n}`, image_url: `${dir}${n}.png`, link_url: null, sort_order: n, status: 'draft', ...overrides })
  const seeds = () => [row(11), row(10, { status: 'published' }), row(12, { store_id: sibling, image_url: `${tenant}/${sibling}/12.png` }), row(13, { tenant_id: foreign })]
  function mount({ role = 'manager', ctx = {}, rows = seeds(), intercept } = {}) {
    const f = { calls: [], unexpected: [], ctx: { role, user: { id: id(8) }, tenantId: tenant, storeId: branch, assignedStoreId: branch, stores, ...ctx } }
    let gen = 0
    f.client = createClient('https://fixture.test', 'local-only', { accessToken: async () => 'fixture', global: { fetch: async (input, init) => {
      const { pathname, searchParams: params } = new URL(input), method = init.method
      const body = typeof init.body === 'string' ? JSON.parse(init.body) : init.body
      const c = { method, pathname, params, body, headers: new Headers(init.headers) }; f.calls.push(c)
      const reply = await intercept?.(c); if (reply) return reply
      if (pathname === table) {
        const matching = rows.filter(r => ['tenant_id', 'store_id', 'id'].every(k => !params.has(k) || params.get(k) === `eq.${r[k]}`))
        if (method === 'GET') {
          const start = Number(params.get('offset') || 0)
          return Response.json(matching.sort((a, b) => a.sort_order - b.sort_order || a.id.localeCompare(b.id)).slice(start, start + Number(params.get('limit') || 1000)))
        }
        if (method === 'POST') { const id = crypto.randomUUID(); rows.push({ ...body, id }); return Response.json([{ id }], { status: 201 }) }
        if (method === 'PATCH') { for (const r of matching) Object.assign(r, body); return Response.json(matching.map(({ id }) => ({ id }))) }
      }
      if (pathname === sign && method === 'POST') {
        gen++; return Response.json(body.paths.map(key => ({ path: key, error: null, signedURL: `/object/sign/storefront-assets/${key}?token=fixture-${gen}` })))
      }
      if (pathname.startsWith(bucket + '/') && method === 'POST') return Response.json({ Id: id(99), Key: pathname })
      if (pathname === bucket && method === 'DELETE') return Response.json([])
      f.unexpected.push(`${method} ${pathname}`); return errorReply(400, 'unexpected')
    } } })
    globalThis.contentFixture = f
    const view = render(createElement(Page))
    f.switchContext = patch => { f.ctx = { ...f.ctx, ...patch }; view.rerender(createElement(Page)) }
    f.reads = () => f.calls.filter(c => c.pathname === table && c.method === 'GET')
    f.writes = () => f.calls.filter(c => c.pathname === table && c.method !== 'GET')
    f.uploads = () => f.calls.filter(c => c.pathname.startsWith(bucket + '/'))
    f.signs = () => f.calls.filter(c => c.pathname === sign)
    return f
  }
  return { route, table, row, mount, routeAllowed }
}
