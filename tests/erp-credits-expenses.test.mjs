import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'

const load = async path =>
  import(`data:text/javascript;base64,${Buffer.from(await fs.readFile(new URL(path, import.meta.url), 'utf8')).toString('base64')}`)

const sql = await fs.readFile(new URL('../supabase/migrations/202611100022_credit_payments_expenses.sql', import.meta.url), 'utf8')
const fn = name => {
  const start = sql.indexOf(`FUNCTION public.${name}`)
  assert.ok(start > -1, `${name} missing`)
  const rest = sql.slice(start)
  const end = rest.indexOf('END $$;')
  return rest.slice(0, end)
}

test('a credit payment is cash: it requires an open shift and updates the drawer', () => {
  const body = fn('engine_credit_payment')
  assert.match(body, /FROM public\.shifts WHERE store_id = c\.store_id AND status = 'open' FOR UPDATE/)
  assert.match(body, /IF s\.id IS NULL THEN RAISE EXCEPTION 'افتح صندوق الفرع قبل تسجيل الدفعة'/)
  assert.match(body, /INSERT INTO public\.credit_payments\(credit_id, store_id, shift_id, amount, created_by, request_id\)/)
  assert.match(body, /total_credit_payments = total_credit_payments \+ p_amount/)
})

test('a credit payment cannot exceed the remaining balance and lowers it', () => {
  const body = fn('engine_credit_payment')
  assert.match(body, /IF p_amount > remaining THEN/)
  assert.match(body, /SET remaining_amount = remaining - p_amount/)
  assert.match(body, /new_status := CASE WHEN remaining - p_amount <= 0 THEN 'paid' ELSE 'active' END/)
})

test('replaying the same request never charges the customer twice', () => {
  const body = fn('engine_credit_payment')
  assert.match(body, /pg_advisory_xact_lock/)
  assert.match(body, /SELECT \* INTO old_row FROM public\.credit_payments WHERE request_id = p_request/)
  assert.match(body, /'replayed', true/)
  // The replay must return before any mutation happens.
  assert.ok(body.indexOf("'replayed', true") < body.indexOf('INSERT INTO public.credit_payments'))
})

test('shift expected cash includes credit payments exactly once', () => {
  const body = fn('engine_close_shift')
  assert.match(body, /expected := s\.expected_cash::bigint \+ sales - s\.total_employee_payments\s*\+\s*coalesce\(s\.total_credit_payments, 0\)/)
  // credit_payments is not summed again from the payments table.
  assert.equal(/FROM public\.credit_payments/.test(body), false)
})

test('the drawer column exists and defaults to zero for existing shifts', () => {
  assert.match(sql, /ALTER TABLE public\.shifts ADD COLUMN IF NOT EXISTS total_credit_payments bigint NOT NULL DEFAULT 0/)
})

test('ledger totals only cover the caller tenant', () => {
  const body = fn('engine_customer_ledger')
  assert.match(body, /st\.tenant_id = u\.tenant_id/)
  assert.match(body, /'totalDebt'/)
  assert.match(body, /'totalPaid'/)
  assert.match(body, /'payments'/)
  assert.match(body, /'credits'/)
})

test('only owners and managers may delete an expense, and deletion is soft', () => {
  const body = fn('engine_delete_expense')
  assert.match(body, /u\.role NOT IN \('owner','manager'\)/)
  assert.match(body, /UPDATE public\.expenses SET deleted_at = now\(\), deleted_by = u\.id/)
  assert.equal(/DELETE FROM public\.expenses/.test(body), false, 'expenses must never be hard deleted')
})

test('accounting and the journal skip soft-deleted expenses', () => {
  assert.match(fn('engine_accounting'), /x\.deleted_at IS NULL/)
  assert.match(fn('engine_journal'), /x\.deleted_at IS NULL/)
})

test('deactivating an employee never deletes the row and bans the auth account', () => {
  const body = fn('engine_set_employee_active')
  assert.match(body, /UPDATE public\.users SET is_active = p_active/)
  assert.equal(/DELETE FROM public\.users/.test(sql), false, 'employees must never be removed')
  assert.match(body, /banned_until = CASE WHEN p_active THEN NULL ELSE 'infinity'::timestamptz END/)
  // An open drawer must be reconciled first.
  assert.match(body, /أغلق صندوق الفرع قبل إيقاف الموظف/)
  // Banning must never be able to fail the profile change.
  assert.match(body, /EXCEPTION WHEN insufficient_privilege THEN/)
  assert.match(body, /IF p_user = u\.id THEN RAISE EXCEPTION/)
})

test('receipts bucket is private and path-scoped by tenant and branch', () => {
  assert.match(sql, /VALUES \('receipts', 'receipts', false, 5242880/)
  assert.match(sql, /split_part\(p_path, '\/', 1\) <> u\.tenant_id::text/)
  assert.match(sql, /split_part\(p_path, '\/', 2\)/)
  assert.match(sql, /CREATE POLICY receipts_read ON storage\.objects FOR SELECT TO authenticated/)
})

test('the expense page upload path matches the storage policy shape', async () => {
  const page = await fs.readFile(new URL('../app/dashboard/expenses/page.js', import.meta.url), 'utf8')
  assert.match(page, /const path = `\$\{ctx\.tenantId\}\/\$\{ctx\.storeId\}\//)
})

test('the expenses page is reachable by every role and listed in the sidebar', async () => {
  const { routeAllowed } = await load('../lib/access.js')
  for (const role of ['owner', 'manager', 'employee']) assert.equal(routeAllowed(role, '/dashboard/expenses'), true)
  const nav = await fs.readFile(new URL('../components/dashboard/navItems.js', import.meta.url), 'utf8')
  assert.match(nav, /href: '\/dashboard\/expenses', label: 'المصاريف'/)
})

test('the dashboard banner uses the required wording', async () => {
  const component = await fs.readFile(new URL('../components/dashboard/CreditLedger.js', import.meta.url), 'utf8')
  assert.match(component, /دفعة كريدي: \$\{detail\.customer \|\| 'زبون'\} - \$\{formatDzd\(detail\.amount\)\}/)
})
