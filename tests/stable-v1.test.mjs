import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'

const read = path => fs.readFile(new URL(path, import.meta.url), 'utf8')
const sql = await read('../supabase/migrations/202611100024_supplier_ledger_and_cash.sql')
const fn = name => {
  const start = sql.indexOf(`FUNCTION public.${name}`)
  assert.ok(start > -1, `${name} missing`)
  const rest = sql.slice(start)
  return rest.slice(0, rest.indexOf('END $$;'))
}

test('only cash credit-settlements reach the drawer', () => {
  const body = fn('engine_credit_payment')
  assert.match(body, /cash_amount := CASE WHEN method = 'cash' THEN p_amount ELSE 0 END/)
  assert.match(body, /IF cash_amount > 0 THEN\s+UPDATE public\.shifts SET total_credit_payments = total_credit_payments \+ cash_amount/)
  // A non-cash settlement must never add to the drawer, and must not be rejected.
  assert.equal(/IF method <> 'cash' THEN RAISE EXCEPTION/.test(body), false)
})

test('the credit payment keeps idempotency, the open-shift rule and the balance cap', () => {
  const body = fn('engine_credit_payment')
  assert.match(body, /pg_advisory_xact_lock/)
  assert.match(body, /IF s\.id IS NULL THEN RAISE EXCEPTION 'افتح صندوق الفرع قبل تسجيل الدفعة'/)
  assert.match(body, /IF p_amount > remaining THEN/)
  assert.match(body, /'replayed', true/)
})

test('the old 3-argument function is dropped so the default does not create an overload', () => {
  assert.match(sql, /DROP FUNCTION IF EXISTS public\.engine_credit_payment\(uuid, integer, uuid\);/)
  const dropAt = sql.indexOf('DROP FUNCTION IF EXISTS public.engine_credit_payment')
  const createAt = sql.indexOf('FUNCTION public.engine_credit_payment(\n  p_credit uuid, p_amount integer, p_request uuid, p_method text DEFAULT')
  assert.ok(dropAt < createAt, 'the drop must come before the new definition')
})

test('close shift counts cash sales scoped to the tenant', () => {
  const body = fn('engine_close_shift')
  assert.match(body, /JOIN public\.stores st ON st\.id = x\.store_id/)
  assert.match(body, /st\.tenant_id = u\.tenant_id/)
  assert.match(body, /x\.payment_method = 'cash'/)
  assert.match(body, /\+ coalesce\(s\.total_credit_payments, 0\)/)
})

test('supplier ledger returns totals, invoices and payments with tenant scope', () => {
  const body = fn('engine_supplier_ledger')
  assert.match(body, /'totalPurchases'/)
  assert.match(body, /'totalPaid'/)
  assert.match(body, /'remaining'/)
  assert.match(body, /'purchases'/)
  assert.match(body, /'payments'/)
  assert.match(body, /WHERE id = p_supplier AND tenant_id = u\.tenant_id/)
  assert.match(body, /u\.role <> 'owner'/)
})

test('payment_method is added idempotently and backfilled before being constrained', () => {
  const add = sql.indexOf('ADD COLUMN IF NOT EXISTS payment_method text')
  const backfill = sql.indexOf("UPDATE public.credit_payments SET payment_method = 'cash' WHERE payment_method IS NULL")
  const constraint = sql.indexOf('credit_payments_method_check')
  assert.ok(add > -1 && backfill > -1 && constraint > -1)
  assert.ok(add < backfill && backfill < constraint, 'add -> backfill -> constrain')
})

test('the dark-mode dropdown style is global and applied through fieldClass', async () => {
  const css = await read('../app/globals.css')
  assert.match(css, /select option,\nselect optgroup \{\n  background-color: #1a1a1a;/)
  assert.match(css, /color-scheme: dark/)

  const ui = await read('../components/dashboard/EngineUI.js')
  assert.match(ui, /export const fieldClass = 'select-field w-full rounded-lg border border-\[#D4AF37\]\/40 bg-\[#1A1A1A\]/)
  assert.match(ui, /export const selectClass = `\$\{fieldClass\} appearance-none`/)
})

test('no select is left with the old light background', async () => {
  const files = ['../app/dashboard/transfers/page.js', '../app/dashboard/pos/page.js',
    '../app/dashboard/products/page.js', '../app/dashboard/purchases/page.js',
    '../app/dashboard/users/page.js', '../components/dashboard/TopBar.js', '../app/super-admin/page.js']
  for (const file of files) {
    const source = await read(file)
    // A select styled with the old neutral-700 / #141414 pair would render light options.
    const selects = source.split('<select').slice(1)
    for (const block of selects) {
      const head = block.slice(0, 400)
      assert.equal(head.includes('bg-[#141414]'), false, `${file} still has an unthemed select`)
    }
  }
})

test('the transfer dropdown lists product - colour - size with availability', async () => {
  const page = await read('../app/dashboard/transfers/page.js')
  assert.match(page, /row\.product_variants\.products\.name\} - \{row\.product_variants\.color\} - \{row\.product_variants\.size\} \(المتاح: \{row\.quantity\}\)/)
  assert.match(page, /<optgroup key=\{name\} label=\{name\}>/)
})

test('the POS preselects a colour so sizes are never filtered to nothing', async () => {
  const page = await read('../app/dashboard/pos/page.js')
  assert.match(page, /const inStock = \(p\.product_variants \|\| \[\]\)\.filter/)
  assert.match(page, /setPicked\(\{ color: inStock\[0\]\?\.color \|\| '', size: '' \}\)/)
})

test('checkout shows total, cash paid and the remaining credit', async () => {
  const page = await read('../app/dashboard/pos/page.js')
  assert.match(page, /const creditRemainder = Math\.max\(0, totals\.amount - paidCash\)/)
  assert.match(page, /المتبقي كريدي/)
  assert.match(page, /المدفوع نقداً/)
})

test('silent failures now log to the console', async () => {
  const sync = await read('../lib/sync.js')
  assert.match(sync, /console\.error\(`\[sync\] \$\{row\.kind\} \$\{row\.local_id\} failed`, err\)/)

  const pos = await read('../app/dashboard/pos/page.js')
  assert.match(pos, /console\.error\('\[pos\] syncPending failed', err\)/)
  assert.match(pos, /console\.error\('\[pos\] completeSale failed', err\)/)
  assert.equal(/syncPending\(\)\.catch\(\(\) => \{\}\)/.test(pos), false, 'sync failures must not be swallowed')

  const shift = await read('../components/dashboard/ShiftManager.js')
  assert.match(shift, /console\.error\('\[shift\] open failed', error\)/)
  assert.match(shift, /console\.error\('\[shift\] close failed', error\)/)
})

test('the supplier ledger modal is reachable by clicking the supplier name', async () => {
  const page = await read('../app/dashboard/suppliers/page.js')
  assert.match(page, /onClick=\{\(\) => setLedger\(supplier\)\}/)
  assert.match(page, /<SupplierLedger supplier=\{ledger\}/)
  const component = await read('../components/dashboard/SupplierLedger.js')
  assert.match(component, /engine_supplier_ledger/)
  assert.match(component, /engine_pay_supplier/)
  // engine_pay_supplier expects tenant and store, not just the supplier id.
  assert.match(component, /p_tenant: supplier\.tenant_id/)
  assert.match(component, /p_store: supplier\.store_id/)
})
