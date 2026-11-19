// Render the real sidebar, phone bar/sheet, tab switcher and page wrappers.
// Only the session, router, badge, top bar and screen bodies are fixtures: no DB.
import test, { afterEach } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { JSDOM } from 'jsdom'
import routing from 'next/experimental/testing/server.js'
import nextConfig from '../next.config.js'

const dom = new JSDOM('<!doctype html><html dir="rtl"><body></body></html>', { url: 'https://local.test/dashboard' })
for (const key of ['window', 'document', 'HTMLElement', 'Node']) globalThis[key] = dom.window[key]
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: dom.window.navigator })
globalThis.IS_REACT_ACT_ENVIRONMENT = true
const { createElement } = await import('react')
const { render, screen, within, fireEvent, cleanup } = await import('@testing-library/react')
afterEach(() => { cleanup(); delete globalThis.navFixture })

const stubs = {
  'next/navigation': `export const usePathname = () => window.location.pathname;
    export const useSearchParams = () => new URLSearchParams(window.location.search);
    export const useRouter = () => globalThis.navFixture.router`,
  SessionProvider: 'export const useDashboardSession = () => globalThis.navFixture.session',
  OrdersBadge: 'export default () => <span data-testid="orders-badge" aria-hidden="true" />',
  TopBar: 'export default () => null',
}
const outfile = path.resolve('.cache/dashboard-nav/pages.mjs')
await build({
  stdin: { contents: `export { default as Stock } from './app/dashboard/stock/page';
    export { default as Trips } from './app/dashboard/trips/page';
    export { default as Shell } from './components/dashboard/DashboardShell'`, resolveDir: process.cwd() },
  outfile, bundle: true, platform: 'node', format: 'esm', jsx: 'automatic', loader: { '.js': 'jsx' },
  external: ['react', 'react/*', 'react-dom', 'react-dom/*'],
  plugins: [{ name: 'nav-boundaries', setup(b) {
    b.onResolve({ filter: /^(next\/navigation|.*\/(SessionProvider|OrdersBadge|TopBar))$/ }, ({ path: id }) =>
      ({ path: id === 'next/navigation' ? id : path.basename(id), namespace: 'stub' }))
    b.onLoad({ filter: /.*/, namespace: 'stub' }, ({ path }) => ({ contents: stubs[path], loader: 'jsx' }))
    b.onResolve({ filter: /^@\/app\/dashboard\/_screens\// }, ({ path: id }) => ({ path: path.basename(id), namespace: 'screen' }))
    b.onLoad({ filter: /.*/, namespace: 'screen' }, ({ path }) => ({ contents: `export default () => ${JSON.stringify(path)}` }))
  } }],
})
const { Stock, Trips, Shell } = await import(pathToFileURL(outfile))
const resolveURL = href => routing.unstable_getResponseFromNextConfig({ url: `https://local.test${href}`, nextConfig })
const groupName = 'التوريد والمشتريات'
const suppliers = ['الموردون', '/dashboard/stock?tab=suppliers']
const purchases = ['المشتريات', '/dashboard/stock?tab=purchases']
const trips = ['رحلات الشراء', '/dashboard/trips']
const inventory = ['المخزون', '/dashboard/stock?tab=inventory']
const transfers = ['نقل المخزون', '/dashboard/stock?tab=transfers']
const procurement = [suppliers, purchases, trips]

function mount(role, href = '/dashboard') {
  const pushes = []
  window.history.replaceState(null, '', href)
  const page = () => createElement(({ '/dashboard/stock': Stock, '/dashboard/trips': Trips })[window.location.pathname] || Shell)
  const visit = (href, method) => {
    window.history[method](null, '', href)
    view.rerender(page())
  }
  globalThis.navFixture = { session: { role }, router: {
    push: href => { pushes.push(href); visit(href, 'pushState') },
    replace: href => visit(href, 'replaceState'),
  } }
  const view = render(page())
  return pushes
}
const sidebar = () => within(screen.getByRole('complementary'))
const more = () => screen.getByRole('button', { name: 'المزيد' })
const bar = () => within(more().closest('nav'))
const sheet = () => within(screen.getByRole('dialog', { name: 'كل الوجهات' }))
const links = scope => scope.getAllByRole('link').map(link => [link.textContent, link.getAttribute('href')])
const selectedHref = scope => scope.getByRole('link', { current: 'page' }).getAttribute('href')

for (const role of ['owner', 'manager', 'employee']) {
  test(`${role}: one procurement group when allowed; inventory and transfers are independent on both menus`, () => {
    const pushes = mount(role)
    const side = sidebar()
    const sideGroup = side.queryByRole('group', { name: groupName })
    assert.equal(Boolean(sideGroup), role !== 'employee')
    if (sideGroup) assert.deepEqual(links(within(sideGroup)), procurement)
    for (const [name, href] of [...procurement, inventory, transfers]) {
      const link = side.queryByRole('link', { name })
      const visible = name === inventory[0] || (name === transfers[0] ? role === 'owner' : role !== 'employee')
      assert.equal(link?.getAttribute('href'), visible ? href : undefined, name)
      if (link) assert.equal(Boolean(link.closest('[role="group"]')), procurement.some(([label]) => label === name), name)
    }

    const primary = links(bar())
    assert.deepEqual(primary.map(([, href]) => href), ['/dashboard', '/dashboard/pos', '/dashboard/orders', inventory[1]])
    assert.equal(screen.getAllByTestId('orders-badge').length, 2)
    assert.equal(more().getAttribute('aria-haspopup'), 'dialog')
    fireEvent.click(more())
    assert.equal(more().getAttribute('aria-expanded'), 'true')
    const dialog = sheet()
    const sheetGroup = dialog.queryByRole('group', { name: groupName })
    assert.equal(Boolean(sheetGroup), role !== 'employee')
    if (sheetGroup) assert.deepEqual(within(sheetGroup).getAllByRole('button').map(b => b.textContent), procurement.map(([name]) => name))
    const transfer = dialog.queryByRole('button', { name: transfers[0] })
    assert.equal(Boolean(transfer), role === 'owner')
    if (transfer) assert.ok(!transfer.closest('[role="group"]'))
    const choices = within(dialog.getByRole('list')).getAllByRole('button').map(b => b.textContent)
    // No missing, duplicate or extra destination on the smaller surface.
    assert.deepEqual([...primary.map(([name]) => name), ...choices].sort(), links(side).map(([name]) => name).sort())
    const [label, href] = role === 'owner' ? transfers : role === 'manager' ? trips : ['الإعدادات', '/dashboard/settings']
    fireEvent.click(dialog.getByRole('button', { name: label }))
    assert.deepEqual(pushes, [href])
    assert.ok(!screen.queryByRole('dialog'))
  })
}

for (const [label, href] of [...procurement, inventory, transfers]) {
  test(`bookmark ${href} opens its original screen and highlights only ${label}`, async () => {
    const tab = new URL(href, 'https://local.test').searchParams.get('tab')
    if (tab) {
      const redirect = await resolveURL(`/dashboard/${tab}`)
      assert.equal(redirect.status, 308)
      assert.equal(redirect.headers.get('location'), `https://local.test${href}`)
    }
    assert.equal((await resolveURL(href)).status, 200, 'the destination itself does not redirect')
    mount('owner', href)
    assert.equal(window.location.pathname + window.location.search, href)
    if (tab) {
      assert.equal(screen.getByRole('tabpanel').textContent, tab)
      assert.equal(screen.getByRole('tab', { selected: true }).textContent, label)
    } else assert.equal(screen.getByRole('main').textContent, 'trips')
    assert.equal(selectedHref(sidebar()), href)
    if (href === inventory[1]) assert.equal(selectedHref(bar()), href)
    else {
      assert.ok(!bar().queryByRole('link', { current: 'page' }))
      assert.ok(more().classList.contains('text-gold'))
      fireEvent.click(more())
      assert.equal(sheet().getByRole('button', { current: 'page' }).textContent, label)
    }
  })
}

test('switching stock tabs updates the highlight without losing the query or changing the stock default', () => {
  mount('manager', '/dashboard/stock?keep=1')
  assert.equal(screen.getByRole('tabpanel').textContent, 'products')
  for (const [label, href] of [suppliers, purchases, inventory]) {
    fireEvent.click(screen.getByRole('tab', { name: label }))
    assert.equal(window.location.pathname + window.location.search, href.replace('?', '?keep=1&'))
    assert.equal(screen.getByRole('tabpanel').textContent, href.split('tab=')[1])
    assert.equal(selectedHref(sidebar()), href)
  }
})

for (const [role, tab, fallback] of [['employee', 'suppliers', 'inventory'], ['manager', 'transfers', 'products']]) {
  test(`${role}: a restricted stock bookmark keeps the existing tab fallback and no forbidden highlight`, () => {
    mount(role, `/dashboard/stock?tab=${tab}`)
    assert.equal(screen.getByRole('tabpanel').textContent, fallback)
    assert.equal(selectedHref(sidebar()), inventory[1])
    assert.equal(selectedHref(bar()), inventory[1])
  })
}
