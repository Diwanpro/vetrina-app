import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'

const read = path => fs.readFile(new URL(path, import.meta.url), 'utf8')
const topbar = await read('../components/dashboard/TopBar.js')
const shift = await read('../components/dashboard/ShiftManager.js')
const modal = await read('../components/dashboard/MixedPaymentModal.js')
const picker = await read('../components/dashboard/CustomerPicker.js')
const ledger = await read('../components/dashboard/LedgerModal.js')
const sql27 = await read('../supabase/migrations/202611100027_customer_identity.sql')
const sql28 = await read('../supabase/migrations/202611100028_detailed_ledgers.sql')

const fn = (source, name) => {
  const start = source.indexOf(`FUNCTION public.${name}(`)
  assert.ok(start > -1, `${name} missing`)
  const body = source.slice(source.indexOf('AS $$', start))
  return body.slice(0, body.indexOf('$$;'))
}

test('the shift button renders whenever a branch is selected', () => {
  // It used to be hidden behind `online && pending.length === 0`, so it
  // disappeared precisely when a sale was stuck in the outbox.
  assert.match(topbar, /\{ctx\.storeId && <ShiftManager \/>\}/)
  assert.equal(/pending\.length === 0 && <ShiftManager/.test(topbar), false)
})

test('the shift button keeps a short label and an accessible name on mobile', () => {
  assert.match(shift, /<span className="hidden sm:inline">\{label\}<\/span>/)
  assert.match(shift, /<span className="sm:hidden">/)
  assert.match(shift, /aria-label=\{aria\}/)
})

test('reading an unassigned record field is what caused "customer is not assigned yet"', () => {
  // `customer record` is unassigned until its first SELECT INTO; testing
  // `customer.id IS NULL` before that raises 55000. A boolean must carry it.
  const sync = fn(sql27, 'engine_sync_sale')
  assert.match(sync, /found_customer boolean := false/)
  assert.equal(/IF customer\.id IS NULL THEN/.test(sync), false, 'no field read before assignment')
  assert.match(sync, /found_customer := FOUND;/)
  // The first test must happen after the first SELECT INTO.
  const firstSelect = sync.indexOf('SELECT * INTO customer')
  const firstTest = sync.indexOf('IF NOT found_customer')
  assert.ok(firstSelect > -1 && firstTest > firstSelect, 'boolean test after the select')
})

test('the credit path refuses to store a debt with no customer', () => {
  const sync = fn(sql27, 'engine_sync_sale')
  assert.match(sync, /IF NOT found_customer OR customer\.id IS NULL THEN\s+RAISE EXCEPTION 'تعذر تحديد الزبون لتسجيل الكريدي'/)
  const manual = fn(sql27, 'engine_create_credit')
  assert.match(manual, /IF NOT found_customer OR customer\.id IS NULL THEN\s+RAISE EXCEPTION 'تعذر تحديد الزبون لتسجيل الكريدي'/)
})

test('an explicit customer id wins over a name lookup', () => {
  const sync = fn(sql27, 'engine_sync_sale')
  const idLookup = sync.indexOf("p_split->>'customer_id'")
  const phoneLookup = sync.indexOf('customer_phone IS NOT NULL')
  assert.ok(idLookup > -1 && idLookup < phoneLookup, 'id checked before phone and name')
  assert.match(sync, /WHERE id = \(p_split->>'customer_id'\)::uuid AND tenant_id = p_tenant/)
})

test('the POS passes the chosen customer id through to the sale', () => {
  // The id is read through a guarded const now; the bare `customer.id || null`
  // form was the shape that black-screened on an unresolved customer.
  assert.match(modal, /customer_id: customerId,/)
  assert.match(modal, /const customerId = typeof customer\?\.id === 'string'/)
  assert.match(modal, /<CustomerPicker tenantId=\{ctx\.tenantId\} value=\{customer\} onChange=\{setCustomer\}/)
})

test('the picker searches the tenant and offers a new-customer path', () => {
  // Searches name OR phone; a cashier may have either on screen.
  assert.match(picker, /\.or\(`name\.ilike\.\$\{pattern\},phone\.ilike\.\$\{pattern\}`\)/)
  assert.match(picker, /\.eq\('tenant_id', tenantId\)/)
  assert.match(picker, /زبون جديد/)
  // Typing a wildcard must not turn into a match-everything query.
  assert.match(picker, /term\.replace\(\/\[%_\\\\\]\/g, '\\\\\$&'\)/)
})

test('picking an existing customer hands back its id rather than its name', () => {
  assert.match(picker, /onChange\(\{ id: row\.id, name: row\.name, phone: row\.phone \|\| '' \}\)/)
})

test('both ledgers return the same entry shape so one table can render them', () => {
  for (const name of ['engine_supplier_ledger_detail', 'engine_customer_ledger_detail']) {
    const body = fn(sql28, name)
    for (const key of ['date', 'kind', 'label', 'detail', 'total', 'cash', 'paper', 'remaining']) {
      assert.match(body, new RegExp(`'${key}'`), `${name} must return ${key}`)
    }
  }
})

test('ledgers are chronological with a running balance', () => {
  for (const name of ['engine_supplier_ledger_detail', 'engine_customer_ledger_detail']) {
    const body = fn(sql28, name)
    assert.match(body, /OVER \(ORDER BY at, kind\)/)
    assert.match(body, /running_total - running_cash - running_paper/)
  }
})

test('ledgers are tenant scoped and never leak another tenant', () => {
  assert.match(fn(sql28, 'engine_supplier_ledger_detail'), /WHERE id = p_supplier AND tenant_id = u\.tenant_id/)
  assert.match(fn(sql28, 'engine_customer_ledger_detail'), /WHERE id = p_customer AND tenant_id = u\.tenant_id/)
})

test('the ledgers only reference columns that exist', () => {
  // Neither payment table has a note column; selecting one fails at runtime.
  assert.equal(/\.note/.test(sql28), false)
  // credit_payments gained payment_method and created_at in 023.
  assert.match(fn(sql28, 'engine_customer_ledger_detail'), /cp\.payment_method/)
  assert.match(fn(sql28, 'engine_customer_ledger_detail'), /cp\.created_at/)
})

test('the ledger modal shows every required column and a payment button', () => {
  for (const heading of ['التاريخ', 'البيان', 'الإجمالي', 'المدفوع نقداً', 'شيك / CCP', 'المتبقي']) {
    assert.ok(ledger.includes(heading), `missing column ${heading}`)
  }
  assert.match(ledger, /تسجيل دفعة/)
  // Customer ledgers have no payment hook on this screen; suppliers do.
  assert.match(ledger, /\{kind === 'supplier' && onPay && <button/)
})

test('one ledger component serves every entry point', async () => {
  const credits = await read('../app/dashboard/_screens/credits.js')
  const customers = await read('../app/dashboard/_screens/customers.js')
  const suppliers = await read('../app/dashboard/_screens/suppliers.js')
  for (const [name, source] of [['credits', credits], ['customers', customers], ['suppliers', suppliers]]) {
    assert.match(source, /import LedgerModal from '@\/components\/dashboard\/LedgerModal'/, name)
  }
  await assert.rejects(read('../components/dashboard/CustomerLedger.js'), 'the orphaned ledger was removed')
  const creditLedger = await read('../components/dashboard/CreditLedger.js')
  assert.equal(/CustomerLedgerModal/.test(creditLedger), false, 'no second customer ledger left')
})

test('the supplier ledger does not attribute customer cheques to a supplier', () => {
  // pending_collections has no supplier_id; joining it by store would list every
  // unrelated cheque on every supplier. It is excluded on purpose.
  const body = fn(sql28, 'engine_supplier_ledger_detail')
  assert.equal(/pending_collections/.test(body), false)
  assert.match(sql28, /no supplier_id, so a store-level/)
})

test('supplier totals survive a supplier with no movements', () => {
  // An aggregate over an empty set yields NULLs; without the coalesce the KPI
  // cards would render "null" for a brand-new supplier.
  const body = fn(sql28, 'engine_supplier_ledger_detail')
  assert.match(body, /coalesce\(sum\(total\), 0\)::bigint/)
  assert.match(body, /coalesce\(sum\(cash\), 0\)::bigint/)
  assert.match(body, /'\[\]'::jsonb/)
})

test('the customer ledger counts payments by their recorded method', () => {
  const body = fn(sql28, 'engine_customer_ledger_detail')
  assert.match(body, /WHEN cp\.payment_method = 'cash' THEN cp\.amount::bigint/)
  assert.match(body, /WHEN cp\.payment_method IN \('check','ccp'\) THEN cp\.amount::bigint/)
})

test('the remaining balance comes from the stored debt, not a recomputation', () => {
  // A ledger that recomputes the balance can disagree with the rest of the app.
  assert.match(fn(sql28, 'engine_supplier_ledger_detail'), /'remaining', coalesce\(s\.total_debt, 0\)/)
  assert.match(fn(sql28, 'engine_customer_ledger_detail'), /sum\(x\.remaining_amount\)/)
})
