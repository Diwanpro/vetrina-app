import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'

import {
  ORDER_TABS, nextStatuses, statusLabel, phoneKey, rejectedCustomers, itemsCount,
  filterByTab, tabCounts, orderWhatsappMessage, telLink,
} from '../lib/orders.js'

const read = path => fs.readFile(new URL(path, import.meta.url), 'utf8')

const order = (overrides = {}) => ({
  id: 'o1', order_number: 'ORD-000001', status: 'new',
  customer_name: 'علي', customer_phone: '0555123456',
  total: 2400, created_at: '2026-11-12T10:00:00Z',
  order_items: [{ qty: 2 }, { qty: 1 }],
  ...overrides,
})

// --- transitions -------------------------------------------------------

test('only the moves the server accepts are offered as buttons', () => {
  assert.deepEqual(nextStatuses('new').map(move => move.key), ['confirmed', 'rejected', 'cancelled'])
  assert.deepEqual(nextStatuses('confirmed').map(move => move.key), ['preparing', 'delivered', 'rejected', 'cancelled'])
  assert.deepEqual(nextStatuses('preparing').map(move => move.key), ['delivered', 'rejected', 'cancelled'])
  // Delivered is final; a closed order offers nothing.
  assert.deepEqual(nextStatuses('delivered'), [])
  assert.deepEqual(nextStatuses('rejected'), [])
  assert.deepEqual(nextStatuses('cancelled'), [])
  assert.deepEqual(nextStatuses(undefined), [])
})

test('the first button is always the happy path, and refusal is marked', () => {
  assert.equal(nextStatuses('new')[0].label, 'تأكيد')
  assert.equal(nextStatuses('confirmed')[0].label, 'تحضير')
  assert.equal(nextStatuses('new')[0].destructive, false)
  assert.equal(nextStatuses('new').at(-1).destructive, true)
  assert.equal(nextStatuses('new').find(move => move.key === 'cancelled').label, 'إلغاء')
})

test('statuses carry Arabic labels', () => {
  assert.equal(statusLabel('new'), 'جديد')
  assert.equal(statusLabel('preparing'), 'قيد التحضير')
  assert.equal(statusLabel('delivered'), 'تم التسليم')
  assert.equal(statusLabel('something-else'), 'something-else')
  assert.deepEqual(ORDER_TABS.map(tab => tab.key), ['new', 'confirmed', 'preparing', 'delivered', 'closed'])
  // Rejected and cancelled share one tab.
  assert.deepEqual(ORDER_TABS.at(-1).statuses, ['rejected', 'cancelled'])
})

test('the buttons mirror the transition table inside update_order_status', async () => {
  const sql = await read('../supabase/migrations/202611120005_ecommerce_phase_a.sql')
  const block = sql.slice(sql.indexOf('CREATE OR REPLACE FUNCTION public.update_order_status'))
  const allowed = {}
  // e.g. (old_status = 'confirmed' AND p_new_status IN ('preparing', 'delivered', ...))
  for (const match of block.matchAll(/old_status = '([a-z]+)'\s+AND p_new_status IN \(([^)]+)\)/g)) {
    allowed[match[1]] = [...match[2].matchAll(/'([a-z]+)'/g)].map(entry => entry[1])
  }
  assert.deepEqual(Object.keys(allowed).sort(), ['confirmed', 'new', 'preparing'])
  for (const [from, targets] of Object.entries(allowed)) {
    assert.deepEqual(nextStatuses(from).map(move => move.key), targets, from)
  }
  // Delivered appears nowhere as a source, which is why the card offers nothing.
  assert.doesNotMatch(block, /old_status = 'delivered'\s+AND p_new_status/)
  assert.deepEqual(nextStatuses('delivered'), [])
})

// --- customer history --------------------------------------------------

test('a customer who refused before is flagged by phone', () => {
  const orders = [
    order({ id: 'a', status: 'new', customer_phone: '0555 12 34 56' }),
    order({ id: 'b', status: 'rejected', customer_phone: '0555123456' }),
    order({ id: 'c', status: 'new', customer_phone: '0666111222' }),
  ]
  const warned = rejectedCustomers(orders)
  assert.equal(warned(phoneKey('0555123456')), true)
  assert.equal(warned(phoneKey('0666111222')), false)
  assert.equal(warned(''), false)
})

test('a cancelled order counts as a refusal too', () => {
  const warned = rejectedCustomers([order({ status: 'cancelled' })])
  assert.equal(warned(phoneKey('0555123456')), true)
})

test('the same phone in another format still matches', () => {
  const warned = rejectedCustomers([order({ status: 'rejected', customer_phone: '+213 555 12 34 56' })])
  assert.equal(warned(phoneKey('0555123456')), true)
})

// --- list helpers ------------------------------------------------------

test('items are counted, not listed', () => {
  assert.equal(itemsCount(order()), 3)
  assert.equal(itemsCount(order({ order_items: [] })), 0)
  assert.equal(itemsCount({}), 0)
})

test('tabs filter and count in one pass', () => {
  const orders = [
    order({ id: '1', status: 'new' }),
    order({ id: '2', status: 'new' }),
    order({ id: '3', status: 'delivered' }),
    order({ id: '4', status: 'cancelled' }),
  ]
  assert.equal(filterByTab(orders, 'new').length, 2)
  assert.equal(filterByTab(orders, 'closed').length, 1)
  assert.equal(filterByTab(orders, 'preparing').length, 0)
  const counts = tabCounts(orders)
  assert.deepEqual(counts.map(entry => [entry.key, entry.count]), [
    ['new', 2], ['confirmed', 0], ['preparing', 0], ['delivered', 1], ['closed', 1],
  ])
})

// --- contact -----------------------------------------------------------

test('the WhatsApp text fits the order status', () => {
  assert.match(orderWhatsappMessage(order(), 'بوتيك'), /ORD-000001/)
  assert.match(orderWhatsappMessage(order(), 'بوتيك'), /بوتيك/)
  assert.match(orderWhatsappMessage(order({ status: 'confirmed' }), 'بوتيك'), /تم تأكيد طلبك/)
  assert.match(orderWhatsappMessage(order({ status: 'delivered' }), 'بوتيك'), /تم تسليم طلبك/)
  assert.match(orderWhatsappMessage(order({ status: 'rejected' }), 'بوتيك'), /نعتذر/)
  assert.doesNotMatch(orderWhatsappMessage(order({ status: 'rejected' }), 'بوتيك'), /تم تسليم/)
})

test('a phone becomes a dialable link', () => {
  assert.equal(telLink('0555123456'), 'tel:0555123456')
  assert.equal(telLink('0555 12 34 56'), 'tel:0555123456')
  assert.equal(telLink(''), '')
})

// --- wiring ------------------------------------------------------------

test('the orders page exists and is reachable from the sidebar', async () => {
  const page = await read('../app/dashboard/orders/page.js')
  assert.match(page, /OrdersScreen/)
  assert.match(page, /active="\/dashboard\/orders"/)

  const nav = await read('../components/dashboard/navItems.js')
  assert.match(nav, /\{ href: '\/dashboard\/orders', label: 'الطلبات', icon: IconOrders, badge: 'orders' \}/)
  assert.match(nav, /'\/dashboard\/orders': '\/dashboard\/orders'/)

  // Owner browsing "all branches" is allowed on this page; the screen scopes.
  const session = await read('../components/dashboard/SessionProvider.js')
  assert.match(session, /'\/dashboard\/orders',/)
})

test('the sidebar and bottom bar both show the new-orders badge', async () => {
  const sidebar = await read('../components/dashboard/Sidebar.js')
  const bottom = await read('../components/dashboard/BottomNav.js')
  assert.match(sidebar, /import OrdersBadge from '\.\/OrdersBadge'/)
  assert.match(sidebar, /\{item\.badge === 'orders' && <OrdersBadge/)
  assert.match(bottom, /import OrdersBadge from '\.\/OrdersBadge'/)
  assert.match(bottom, /\{item\.badge === 'orders' && <OrdersBadge/)

  const badge = await read('../components/dashboard/OrdersBadge.js')
  assert.match(badge, /\.eq\('status', 'new'\)/)
  assert.match(badge, /count: 'exact', head: true/)
  // Managers are pinned to their store, owners may look at the whole tenant.
  assert.match(badge, /ctx\.allBranches \? query\.eq\('tenant_id', ctx\.tenantId\) : query\.eq\('store_id', ctx\.storeId\)/)
})

test('the screen updates orders through the RPC, never by writing the table', async () => {
  const screen = await read('../app/dashboard/_screens/orders.js')
  assert.match(screen, /rpc\('update_order_status', \{/)
  assert.match(screen, /p_order_id: order\.id/)
  assert.match(screen, /p_new_status: status/)
  assert.match(screen, /p_reason: note \|\| null/)
  assert.doesNotMatch(screen, /\.from\('orders'\)\s*\.update\(/)
  // Health warning and the card facts the merchant needs.
  assert.match(screen, /تحذير: رفض سابق/)
  assert.match(screen, /order\.order_number/)
  assert.match(screen, /order\.customer_phone/)
  assert.match(screen, /order\.wilaya_code/)
  assert.match(screen, /قطعة/)
})

// --- QR section --------------------------------------------------------

test('the settings tab prints a QR for the public store link', async () => {
  const settings = await read('../app/dashboard/_screens/settings.js')
  assert.match(settings, /import \{ QRCodeSVG \} from 'qrcode\.react'/)
  assert.match(settings, /رابط المتجر والـ QR/)
  assert.match(settings, /const storeUrl = slug \? `\$\{origin\}\/s\/\$\{slug\}` : ''/)
  assert.match(settings, /navigator\.clipboard\.writeText\(storeUrl\)/)
  assert.match(settings, /<QRCodeSVG value=\{storeUrl\}/)
  assert.match(settings, /طباعة الـ QR/)
  // The print sheet carries the logo and the shop name.
  assert.match(settings, /sheetWindow\.print\(\)/)
  assert.match(settings, /storeSettings\.logo_url/)
  assert.match(settings, /storeSettings\.name/)
})
