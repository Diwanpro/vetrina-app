import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'

const read = path => fs.readFile(new URL(path, import.meta.url), 'utf8')
// navItems imports JSX icon components, so evaluate a stripped copy instead of
// letting Node resolve the extensionless import.
const loadNav = async () => {
  const source = (await read('../components/dashboard/navItems.js'))
    .replace(/^import \{[\s\S]*?\} from '\.\/icons'\n/, '')
    .replace(/icon: Icon\w+/g, "icon: 'x'")
  return import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`)
}
const nav = await read('../components/dashboard/navItems.js')
const sql = await read('../supabase/migrations/202611100026_close_shift_expenses.sql')
// Static import: a dynamic `await import` inside a non-async arrow in the test
// body below is a syntax error, so load it once up here.
import { expectedCash } from '../lib/cash.js'

const fn = (source, name) => {
  const start = source.indexOf(`FUNCTION public.${name}(`)
  assert.ok(start > -1, `${name} missing`)
  const body = source.slice(source.indexOf('AS $$', start))
  return body.slice(0, body.indexOf('$$;'))
}

test('the sidebar holds exactly the seven grouped destinations', async () => {
  const entries = [...nav.matchAll(/\{ href: '([^']+)', label: '([^']+)'/g)].map(m => [m[1], m[2]])
  assert.equal(entries.length, 7)
  assert.deepEqual(entries.map(e => e[1]), [
    'لوحة التحكم', 'نقطة البيع', 'العمليات اليومية', 'الزبائن والكريدي',
    'المخزون والموردون', 'الإدارة والمحاسبة', 'الإعدادات',
  ])
})

test('every legacy route still resolves to a sidebar entry', async () => {
  const { activeGroup } = await loadNav()
  const cases = {
    '/dashboard/sales': '/dashboard/operations',
    '/dashboard/collections': '/dashboard/operations',
    '/dashboard/expenses': '/dashboard/operations',
    '/dashboard/credits': '/dashboard/customers-credit',
    '/dashboard/customers': '/dashboard/customers-credit',
    '/dashboard/products': '/dashboard/stock',
    '/dashboard/inventory': '/dashboard/stock',
    '/dashboard/transfers': '/dashboard/stock',
    '/dashboard/suppliers': '/dashboard/stock',
    '/dashboard/purchases': '/dashboard/stock',
    '/dashboard/accounting': '/dashboard/management',
    '/dashboard/users': '/dashboard/management',
    '/dashboard/pos': '/dashboard/pos',
    '/dashboard/settings': '/dashboard/settings',
  }
  const hrefs = new Set([...nav.matchAll(/href: '([^']+)'/g)].map(m => m[1]))
  for (const [route, group] of Object.entries(cases)) {
    assert.equal(activeGroup(route), group, `${route} -> ${group}`)
    assert.ok(hrefs.has(group), `${group} must exist in the sidebar`)
  }
})

test('the tab groups contain the screens the spec lists', async () => {
  const cases = [
    ['operations', ['سجل المبيعات', 'المستحقات', 'المصاريف']],
    ['customers-credit', ['الكريدي', 'الزبائن']],
    ['stock', ['المنتجات', 'المخزون', 'نقل المخزون', 'الموردون', 'المشتريات']],
    ['management', ['المحاسبة', 'الموظفون']],
  ]
  for (const [path, labels] of cases) {
    const source = await read(`../app/dashboard/${path}/page.js`)
    const found = [...source.matchAll(/label: '([^']+)'/g)].map(m => m[1])
    assert.deepEqual(found, labels, `${path} tabs`)
  }
})

test('grouped pages are open to all roles and still filter their tabs', async () => {
  const { routeAllowed } = await import('../lib/access.js')
  for (const group of ['/dashboard/operations', '/dashboard/customers-credit', '/dashboard/stock', '/dashboard/management']) {
    for (const role of ['owner', 'manager', 'employee']) {
      assert.equal(routeAllowed(role, group), true, `${role} ${group}`)
    }
  }
  // The underlying gated routes keep their own rules.
  assert.equal(routeAllowed('employee', '/dashboard/accounting'), false)
  assert.equal(routeAllowed('employee', '/dashboard/collections'), false)

  const tabs = await read('../components/dashboard/TabbedPage.js')
  assert.match(tabs, /tabs\.filter\(tab => !ctx \|\| routeAllowed\(ctx\.role, tab\.href\)\)/)
})

test('sub-pages no longer render their own shell', async () => {
  for (const name of ['sales', 'collections', 'expenses', 'credits', 'products', 'inventory',
    'transfers', 'suppliers', 'accounting', 'users', 'customers', 'settings', 'purchases']) {
    const source = await read(`../app/dashboard/_screens/${name}.js`)
    assert.equal(source.includes('DashboardShell'), false, `${name} must not nest a shell`)
  }
  // The standalone POS keeps its own.
  const pos = await read('../app/dashboard/pos/page.js')
  assert.match(pos, /<DashboardShell active="\/dashboard\/pos">/)
})

test('expected cash subtracts expenses and includes every drawer component', () => {
  assert.equal(expectedCash({
    openingFloat: 10000, cashSales: 5000, creditPayments: 2000,
    collections: 3000, employeePayments: 1000, expenses: 500,
  }), 18500)
  // Missing inputs are treated as zero rather than producing NaN.
  assert.equal(expectedCash({}), 0)})

test('the client helper and the server function agree', async () => {
  const body = fn(sql, 'engine_close_shift')
  // Same order of additions and subtractions on both sides.
  assert.match(body, /expected := s\.expected_cash::bigint \+ sales - s\.total_employee_payments/)
  assert.match(body, /\+ coalesce\(s\.total_credit_payments, 0\) \+ coalesce\(s\.total_collections, 0\)/)
  assert.match(body, /- spent;/)

  const shift = await read('../components/dashboard/ShiftManager.js')
  assert.match(shift, /expectedCash\(\{/)
  assert.match(shift, /expenses: drawerExpenses/)
  assert.match(shift, /creditPayments: shift\?\.total_credit_payments/)
  assert.match(shift, /collections: shift\?\.total_collections/)})

test('close shift reads cash_amount, never the invoice total', async () => {
  const body = fn(sql, 'engine_close_shift')
  assert.match(body, /coalesce\(sum\(x\.cash_amount\), 0\) INTO sales/)
  assert.equal(/sum\(x\.total_amount\)/.test(body), false)

  const shift = await read('../components/dashboard/ShiftManager.js')
  assert.match(shift, /select\('id, cash_amount'\)/)
  assert.match(shift, /Number\(row\.cash_amount \|\| 0\)/)
  assert.equal(/Number\(row\.total_amount/.test(shift), false)})

test('expenses are deducted from the drawer on both sides', async () => {
  assert.match(fn(sql, 'engine_close_shift'), /coalesce\(sum\(x\.amount\), 0\) INTO spent/)
  const shift = await read('../components/dashboard/ShiftManager.js')
  assert.match(shift, /expensesForShift/)
  assert.match(shift, /\.is\('deleted_at', null\)/)})

test('the dashboard cash KPI also uses cash_amount', async () => {
  const page = await read('../app/dashboard/page.js')
  assert.match(page, /select\('id, total_amount, cash_amount, payment_method/)
  assert.match(page, /const cash = rows\.reduce\(\(s, r\) => s \+ Number\(r\.cash_amount \|\| 0\), 0\)/)
})

test('the dashboard shows total credit from the credits table', async () => {
  const page = await read('../app/dashboard/page.js')
  assert.match(page, /title="إجمالي الكريدي"/)
  assert.match(page, /engine_total_credit/)
  const body = fn(sql, 'engine_total_credit')
  assert.match(body, /coalesce\(sum\(c\.remaining_amount\), 0\)/)
  assert.match(body, /cust\.tenant_id = u\.tenant_id/)
  assert.match(body, /c\.remaining_amount > 0/)
})

test('customer lookup is tenant-scoped and no longer joins this store credits', async () => {
  const page = await read('../app/dashboard/_screens/credits.js')
  // The old lookup inner-joined credits on the current store, so a customer
  // with debts in another branch never matched and was duplicated. Matching is
  // now done server-side in one transaction.
  assert.equal(/credits!inner\(store_id\)/.test(page), false)
  assert.match(page, /supabase\.rpc\('engine_create_credit'/)
})

test('the server-side credit matcher uses phone first, then exact name', async () => {
  const source = await read('../supabase/migrations/202611100025_mixed_payment_collections.sql')
  const body = fn(source, 'engine_sync_sale')
  const phoneAt = body.indexOf("phone = trim(p_split->>'customer_phone')")
  const nameAt = body.indexOf('name = customer_key')
  assert.ok(phoneAt > -1 && nameAt > phoneAt, 'phone match before name match')
  assert.match(body, /WHERE tenant_id = p_tenant AND name = customer_key/)
  // Creating must be the fallback, after both lookups fail.
  assert.ok(body.indexOf('INSERT INTO public.customers') > nameAt)})

test('purchases is reachable: it is a stock tab, not an orphaned route', async () => {
  // It lost its shell during the restructure and had no tab hosting it, so the
  // supplier screen's "فاتورة شراء" link rendered a page with no sidebar.
  const stock = await read('../app/dashboard/stock/page.js')
  assert.match(stock, /import PurchasesPage from '@\/app\/dashboard\/_screens\/purchases'/)
  assert.match(stock, /key: 'purchases'/)
  const config = await read('../next.config.js')
  assert.match(config, /source: '\/dashboard\/purchases', destination: '\/dashboard\/stock\?tab=purchases'/)
})

test('no internal link points at a redirected legacy route', async () => {
  const offenders = []
  const walk = async dir => {
    for (const entry of await fs.readdir(new URL(dir, import.meta.url), { withFileTypes: true })) {
      const next = `${dir}/${entry.name}`
      if (entry.isDirectory()) await walk(next)
      else if (entry.name.endsWith('.js')) {
        const source = await read(next)
        for (const hit of source.matchAll(/href="\/dashboard\/(sales|collections|expenses|credits|customers|products|inventory|transfers|suppliers|accounting|users|purchases)"/g)) {
          offenders.push(`${next} -> ${hit[0]}`)
        }
      }
    }
  }
  await walk('../app')
  await walk('../components')
  assert.deepEqual(offenders, [])
})

test('legacy URLs still land on the right tab', async () => {
  const config = await read('../next.config.js')
  const expected = {
    sales: 'operations?tab=sales', collections: 'operations?tab=collections',
    expenses: 'operations?tab=expenses', credits: 'customers-credit?tab=credits',
    customers: 'customers-credit?tab=customers', products: 'stock?tab=products',
    inventory: 'stock?tab=inventory', transfers: 'stock?tab=transfers',
    suppliers: 'stock?tab=suppliers', purchases: 'stock?tab=purchases',
    accounting: 'management?tab=accounting', users: 'management?tab=employees',
  }
  for (const [from, to] of Object.entries(expected)) {
    assert.match(config, new RegExp(`source: '/dashboard/${from}', destination: '/dashboard/${to.replace('?', '\\?')}'`), from)
  }
})

test('an owner viewing all branches is not blocked from grouped pages', async () => {
  const provider = await read('../components/dashboard/SessionProvider.js')
  for (const group of ['operations', 'customers-credit', 'stock', 'management']) {
    assert.match(provider, new RegExp(`'/dashboard/${group}'`), group)
  }
})
