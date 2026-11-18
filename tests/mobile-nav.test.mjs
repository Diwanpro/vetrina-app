// The phone bar is a short list plus a «المزيد» sheet; the sidebar is the full
// menu. These are static checks on the two files, because the behaviour under
// test is which items each surface is allowed to render.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'

const read = path => fs.readFile(new URL(`../${path}`, import.meta.url), 'utf8')

const nav = await read('components/dashboard/navItems.js')
const bottom = await read('components/dashboard/BottomNav.js')
const sidebar = await read('components/dashboard/Sidebar.js')
const access = await read('lib/access.js')

// Pull the item list out of navItems.js by evaluating it with the icon imports
// stubbed, exactly like tests/tabs-and-cash.test.mjs does.
const source = nav
  .replace(/^import \{[\s\S]*?\} from '\.\/icons'\n/, '')
  .replace(/icon: Icon\w+/g, "icon: 'x'")
const { NAV_ITEMS, MOBILE_NAV_ITEMS, MORE_NAV_ITEMS } = await import(
  `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`
)

test('the nav list is still the single source of truth, and the phone flags live on it', () => {
  assert.equal(NAV_ITEMS.length, 9)
  assert.deepEqual(NAV_ITEMS.map(item => item.label), [
    'لوحة التحكم', 'نقطة البيع', 'الطلبات', 'العمليات اليومية', 'الزبائن والكريدي',
    'المخزون والموردون', 'رحلات الشراء', 'الإدارة والمحاسبة', 'الإعدادات',
  ])
  assert.deepEqual(MOBILE_NAV_ITEMS.map(item => item.href), [
    '/dashboard', '/dashboard/pos', '/dashboard/orders', '/dashboard/stock',
  ])
  assert.deepEqual(MORE_NAV_ITEMS.map(item => item.href), [
    '/dashboard/operations', '/dashboard/customers-credit', '/dashboard/trips',
    '/dashboard/management', '/dashboard/settings',
  ])
})

test('the bar and the sheet both filter by the same rule the sidebar uses', () => {
  for (const name of ['MOBILE_NAV_ITEMS', 'MORE_NAV_ITEMS']) {
    assert.match(bottom, new RegExp(`routeAllowed\\(ctx\\.role, item\\.href\\)`))
  }
  // The bar must not fall back to the full list, and the sheet must not either.
  // The lookbehind keeps MOBILE_NAV_ITEMS.filter from matching as NAV_ITEMS.filter.
  assert.doesNotMatch(bottom, /(?<![A-Z_])NAV_ITEMS\.filter/)
  assert.match(bottom, /MOBILE_NAV_ITEMS\.filter/)
  assert.match(bottom, /MORE_NAV_ITEMS\.filter/)
  // The rule itself is untouched.
  assert.doesNotMatch(access, /MOBILE_NAV_ITEMS|MORE_NAV_ITEMS/)
})

test('the sidebar is unchanged: it still renders the full list, unfiltered by mobile', () => {
  assert.match(sidebar, /NAV_ITEMS\.filter\(item => ctx && routeAllowed\(ctx\.role, item\.href\)\)/)
  assert.doesNotMatch(sidebar, /mobile|MOBILE_NAV_ITEMS|MORE_NAV_ITEMS/)
})

test('the «المزيد» button is a real control, and the sheet is the shared BottomSheet', () => {
  assert.match(bottom, /setMoreOpen\(true\)/)
  assert.match(bottom, /aria-haspopup="dialog"/)
  assert.match(bottom, /import BottomSheet from '\.\/BottomSheet'/)
  assert.match(bottom, /<BottomSheet/)
  // Choosing an item closes the sheet before navigating.
  assert.match(bottom, /setMoreOpen\(false\)\s*\n?\s*router\.push\(href\)/)
})

test('the active group still drives the highlight, and the orders badge stays in the bar', () => {
  assert.match(bottom, /activeGroup\(pathname \|\| active\)/)
  assert.match(bottom, /item\.badge === 'orders' && <OrdersBadge/)
  assert.match(bottom, /OrdersBadge/)
})

test('the mobile flag cannot widen a role: every rendered item is still gated', () => {
  // Reproduce the two filters the component performs and prove that for each
  // role, the union of bar + sheet never contains a route routeAllowed rejects.
  const logic = access.slice(access.indexOf('export function routeAllowed'))
    .replace(/export /g, '')
  const routeAllowed = new Function(`${logic}; return routeAllowed`)()
  const items = [...MOBILE_NAV_ITEMS, ...MORE_NAV_ITEMS]
  assert.equal(items.length, NAV_ITEMS.length)
  for (const role of ['owner', 'manager', 'employee']) {
    for (const item of items) {
      const inBar = MOBILE_NAV_ITEMS.includes(item) && routeAllowed(role, item.href)
      const inSheet = MORE_NAV_ITEMS.includes(item) && routeAllowed(role, item.href)
      assert.equal(inBar || inSheet, routeAllowed(role, item.href), `${role} ${item.href}`)
    }
  }
})
