import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'

const read = path => fs.readFile(new URL(path, import.meta.url), 'utf8')
const sql = await read('../supabase/migrations/202611100025_mixed_payment_collections.sql')
const fn = name => {
  const start = sql.indexOf(`FUNCTION public.${name}(`)
  assert.ok(start > -1, `${name} missing`)
  const rest = sql.slice(sql.indexOf('AS $$', start))
  return rest.slice(0, rest.indexOf('$$;'))
}

test('cash taken is recorded separately from the invoice total', () => {
  assert.match(sql, /ALTER TABLE public\.sales ADD COLUMN IF NOT EXISTS cash_amount bigint/)
  assert.match(sql, /UPDATE public\.sales SET cash_amount = CASE WHEN payment_method = 'cash' THEN total_amount ELSE 0 END/)
  // Backfill must precede the NOT NULL, or the ALTER fails on existing rows.
  const backfill = sql.indexOf('UPDATE public.sales SET cash_amount = CASE')
  const notNull = sql.indexOf('ALTER COLUMN cash_amount SET NOT NULL')
  assert.ok(backfill < notNull, 'backfill before NOT NULL')
  assert.match(sql, /CHECK \(cash_amount >= 0 AND cash_amount <= total_amount\)/)
})

test('the drawer counts cash handed over, not the whole ticket', () => {
  const body = fn('engine_close_shift')
  assert.match(body, /coalesce\(sum\(x\.cash_amount\), 0\) INTO sales/)
  assert.equal(/sum\(x\.total_amount\)/.test(body), false, 'must not sum the invoice total')
  assert.match(body, /\+ coalesce\(s\.total_credit_payments, 0\) \+ coalesce\(s\.total_collections, 0\)/)
})

test('a split must reconcile to the invoice or the sale is rejected', () => {
  const body = fn('engine_sync_sale')
  assert.match(body, /IF cash_taken \+ due <> total::bigint THEN RAISE EXCEPTION 'المدفوع نقداً والمتبقي لا يساويان إجمالي الفاتورة'/)
  assert.match(body, /IF cash_taken IS NULL OR due IS NULL OR cash_taken < 0 OR due <= 0 THEN/)
})

test('a check or CCP remainder cannot be stored without its receipt', () => {
  const body = fn('engine_sync_sale')
  assert.match(body, /IF method IN \('check','ccp'\) AND receipt IS NULL THEN RAISE EXCEPTION 'أرفق صورة الشيك أو الوصل'/)
  assert.match(body, /IF method = 'credit' AND customer_key IS NULL THEN RAISE EXCEPTION 'اسم الزبون مطلوب/)
  // A NULL method must be rejected: NOT IN evaluates to NULL and would skip the guard.
  assert.match(body, /IF method IS NULL OR method NOT IN \('credit','check','ccp'\) THEN/)
})

test('the debt row is written inside the sale transaction and points at the sale', () => {
  const body = fn('engine_sync_sale')
  // The credit insert uses the id just minted by the sales insert.
  assert.match(body, /INSERT INTO public\.credits\(store_id, created_by, customer_id, total_amount, remaining_amount, description, status, sale_id\)/)
  assert.match(body, /VALUES\(p_store, staff, customer\.id, due, due, 'فاتورة بيع مختلط', 'active', result\)/)
  assert.match(body, /INSERT INTO public\.pending_collections\(store_id, customer_name, amount, payment_method, receipt_url, status, sale_id\)/)
  assert.match(body, /VALUES\(p_store, coalesce\(customer_key,''\), due, method, receipt, 'pending', result\)/)
})

test('the old sync signatures are dropped so the default argument is not an overload', () => {
  assert.match(sql, /DROP FUNCTION IF EXISTS public\.engine_sync_sale\(uuid, uuid, text, jsonb, text, timestamptz\);/)
  assert.match(sql, /DROP FUNCTION IF EXISTS public\.engine_sync_sale_for_staff\(uuid, uuid, text, jsonb, text, timestamptz, uuid\);/)
  const drop = sql.indexOf('DROP FUNCTION IF EXISTS public.engine_sync_sale(')
  const create = sql.indexOf('CREATE FUNCTION public.engine_sync_sale(')
  assert.ok(drop > -1 && drop < create, 'drop before create')
})

test('without a split the old whole-ticket behaviour is unchanged', () => {
  const body = fn('engine_sync_sale')
  assert.match(body, /IF p_split IS NULL OR p_split = 'null'::jsonb THEN/)
  assert.match(body, /cash_taken := CASE WHEN p_payment='cash' THEN total::bigint ELSE 0 END;/)
})

test('credits gain a sale_id foreign key', () => {
  assert.match(sql, /ALTER TABLE public\.credits ADD COLUMN IF NOT EXISTS sale_id uuid/)
  assert.match(sql, /FOREIGN KEY \(sale_id\) REFERENCES public\.sales\(id\) ON DELETE SET NULL/)
  assert.match(sql, /CREATE INDEX IF NOT EXISTS credits_sale_id/)
})

test('one pending collection per sale, so a replayed sync cannot queue it twice', () => {
  assert.match(sql, /CREATE UNIQUE INDEX IF NOT EXISTS pending_collections_sale\s+ON public\.pending_collections\(sale_id\) WHERE sale_id IS NOT NULL/)
})

test('pending collections are listed tenant-scoped and pending only', () => {
  const body = fn('engine_pending_collections')
  assert.match(body, /WHERE st\.tenant_id = u\.tenant_id/)
  assert.match(body, /AND pc\.status = 'pending'/)
})

test('clearing to cash needs an open shift; clearing cannot happen twice', () => {
  const body = fn('engine_clear_pending_collection')
  assert.match(body, /WHERE id = p_id FOR UPDATE/)
  assert.match(body, /IF pc\.status <> 'pending' THEN RAISE EXCEPTION 'تم تحصيل هذا الشيك مسبقاً'/)
  assert.match(body, /IF s\.id IS NULL THEN RAISE EXCEPTION 'افتح صندوق الفرع قبل التحصيل'/)
  assert.match(body, /UPDATE public\.shifts SET total_collections = coalesce\(total_collections,0\) \+ pc\.amount/)
})

test('bank clearing never touches the shift and no clearing adds revenue', () => {
  const body = fn('engine_clear_pending_collection')
  const cashBranch = body.slice(body.indexOf("IF p_destination = 'cash' THEN"), body.indexOf('ELSE'))
  assert.match(cashBranch, /total_collections/)
  const bankBranch = body.slice(body.indexOf('ELSE'), body.indexOf('UPDATE public.pending_collections'))
  assert.equal(/UPDATE public\.shifts/.test(bankBranch), false, 'bank must not touch the shift')
  assert.equal(/sales|revenue|total_amount/.test(body), false, 'clearing must not book revenue')
})

test('the POS asks how a remainder above 100 DZD will be settled', async () => {
  const page = await read('../app/dashboard/pos/page.js')
  assert.match(page, /if \(creditRemainder > 100\) \{ setSplitting\(true\); return \}/)
  assert.match(page, /onClick=\{\(\) => requestSale\(\)\}/)
  assert.match(page, /<MixedPaymentModal ctx=\{ctx\} remainder=\{creditRemainder\}/)
})

test('the split travels through the outbox to the server', async () => {
  const local = await read('../lib/local-db.js')
  assert.match(local, /export async function persistLocalSale\(ctx, cart, payment, split = null\)/)
  assert.match(local, /split: split \|\| null,/)
  assert.match(local, /row\.split\.cash \+ row\.split\.amount !== row\.total_amount/)

  const sync = await read('../lib/sync.js')
  assert.match(sync, /p_split: row\.split \|\| null,/)
})

test('the mixed payment modal offers credit, check and CCP, and requires a file', async () => {
  const modal = await read('../components/dashboard/MixedPaymentModal.js')
  // Native <option>s became CustomSelect options; the three methods and their
  // labels are what the test is really about.
  assert.match(modal, /\{ label: 'كريدي', value: 'credit' \}/)
  assert.match(modal, /\{ label: 'شيك', value: 'check' \}/)
  assert.match(modal, /\{ label: 'بريدي', value: 'ccp' \}/)
  assert.match(modal, /أرفق صورة الشيك \/ الوصل/)
  assert.match(modal, /اسم الزبون/)
  // The free-text name and phone were replaced by a customer autocomplete.
  assert.match(modal, /<CustomerPicker/)
  assert.match(modal, /المبلغ المتبقي:/)
  assert.match(modal, /supabase\.storage\.from\(BUCKET\)\.upload/)
  // Dark/gold is per the standing UI rule.
  assert.match(modal, /selectClass/)
  // Must sit above the POS product sheet (z-50) or it opens behind it.
  assert.match(modal, /z-\[60\]/)
})

test('collections page is reachable from the sidebar and gated to owner/manager', async () => {
  // Collections is the second tab of daily operations, not a sidebar entry.
  const group = await read('../app/dashboard/operations/page.js')
  assert.match(group, /label: 'المستحقات'/)
  assert.match(group, /component: CollectionsPage/)
  const access = await read('../lib/access.js')
  assert.match(access, /if \(path\.startsWith\('\/dashboard\/collections'\)\) return role === 'owner' \|\| role === 'manager'/)
  const page = await read('../app/dashboard/_screens/collections.js')
  assert.match(page, /engine_pending_collections/)
  assert.match(page, /engine_clear_pending_collection/)
  assert.match(page, /أين تريد إيداع المبلغ؟/)
  assert.match(page, /الصندوق \(Cash\)/)
  assert.match(page, /البنك \(Bank\)/)
  assert.match(page, /تم التحصيل/)
})
