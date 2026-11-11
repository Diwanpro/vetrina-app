import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const read = p => fs.readFile(path.join(ROOT, p), 'utf8')

// Strip line comments before matching SQL: a rule mentioned in prose must not
// satisfy a test that is supposed to check the executable statements.
const sqlOf = async p => (await read(p)).split('\n').filter(l => !l.trim().startsWith('--')).join('\n')

const merge = await sqlOf('supabase/migrations/202611100029_merge_duplicates.sql')
const mergeRaw = await read('supabase/migrations/202611100029_merge_duplicates.sql')
const credits = await read('app/dashboard/_screens/credits.js')
const picker = await read('components/dashboard/CustomerPicker.js')
const modal = await read('components/dashboard/MixedPaymentModal.js')

  test('engine_create_credit accepts an optional customer id', () => {
  assert.match(merge, /p_customer_id uuid DEFAULT NULL/)
  // The old signature is dropped so an older client cannot keep resolving by
  // name and re-create the duplicates this migration merges.
  assert.match(merge, /DROP FUNCTION IF EXISTS public\.engine_create_credit\(uuid, text, text, integer, text, date\)/)
  assert.match(merge, /GRANT EXECUTE ON FUNCTION public\.engine_create_credit\(uuid, text, text, integer, text, date, uuid\)/)
})

test('the id is honoured before phone and name', () => {
  const body = merge.slice(merge.indexOf('CREATE OR REPLACE FUNCTION public.engine_resolve_customer'))
  const idAt = body.indexOf('IF p_customer_id IS NOT NULL')
  const phoneAt = body.indexOf('AND clean_phone IS NOT NULL THEN')
  const nameAt = body.indexOf('WHERE tenant_id = p_tenant AND match_key = public.customer_match_key(clean_name)')
  assert.ok(idAt > 0 && phoneAt > idAt && nameAt > phoneAt, 'order must be id -> phone -> name')
})

test('an id from another tenant is rejected, not silently re-matched', () => {
  assert.match(merge, /WHERE id = p_customer_id AND tenant_id = p_tenant/)
  assert.match(merge, /الزبون المحدد غير موجود في هذه المؤسسة/)
})

test('resolution never reads a record that was not assigned', () => {
  // The 55000 bug: `rec.field IS NULL` on an unassigned record crashes. Every
  // branch must set the boolean from FOUND instead.
  assert.equal(/rec\.\w+ IS NULL/.test(merge), false)
  assert.match(merge, /found_customer := FOUND/)
  assert.match(merge, /IF NOT found_customer THEN\s+RAISE EXCEPTION 'تعذر تحديد الزبون/)
})

test('the resolver is not callable by clients directly', () => {
  // It takes a tenant id as an argument; exposing it would cross tenants.
  assert.match(merge, /REVOKE ALL ON FUNCTION public\.engine_resolve_customer\(uuid, uuid, text, text\) FROM PUBLIC, anon, authenticated/)
  assert.equal(/GRANT EXECUTE ON FUNCTION public\.engine_resolve_customer/.test(merge), false)
})

test('duplicates are grouped on the name, not the stored match_key', () => {
  // 027 suffixed every duplicate's key, so grouping on the column finds nothing.
  assert.match(merge, /public\.customer_match_key\(name\) AS base_key/)
  assert.equal(/PARTITION BY tenant_id, match_key/.test(merge), false)
})

test('the oldest row is the one kept', () => {
  const order = merge.match(/ORDER BY created_at NULLS LAST, id/g) || []
  assert.ok(order.length >= 3, 'every ranking and lookup must prefer the oldest row')
})

test('a name with several phone numbers is not merged blindly', () => {
  // Two different people called محمد must not become one ledger.
  assert.match(merge, /COUNT\(DISTINCT norm_phone\)|count\(DISTINCT norm_phone\)/)
  assert.match(merge, /CASE WHEN coalesce\(n\.distinct_phones, 0\) <= 1/)
  assert.match(merge, /several phone numbers|left these names unmerged/i)
})

test('credits are re-pointed before any customer is deleted', () => {
  const updateAt = merge.indexOf('UPDATE public.credits c')
  const deleteAt = merge.indexOf('DELETE FROM public.customers c')
  assert.ok(updateAt > 0, 'credits must be re-pointed')
  assert.ok(deleteAt > updateAt, 'delete must come after the re-point')
})

test('the delete is guarded against orphaning a debt', () => {
  assert.match(merge, /credits still reference duplicate customers after re-pointing; aborting/)
})

test('the merge refuses to run if another table holds a customer_id', () => {
  assert.match(merge, /column_name = 'customer_id'/)
  assert.match(merge, /RAISE EXCEPTION '029: customer_id also exists on: %\./)
  // credit_payments reaches a customer through credit_id, which is why the
  // guard is expected to pass today.
  assert.match(mergeRaw, /credit_payments reaches a customer through `credit_id`|reaches a customer through `credit_id`/)
})

test('a second run is a no-op', () => {
  assert.match(merge, /WHERE keep_id <> id/)
  assert.match(merge, /no duplicate customers to merge/)
})

test('it fails loudly when 027 has not been applied', () => {
  assert.match(merge, /029 requires migration 027/)
})

test('keys are restored only after the deletes', () => {
  const deleteAt = merge.indexOf('DELETE FROM public.customers c')
  const restoreAt = merge.indexOf('SET match_key = public.customer_match_key(name)')
  assert.ok(restoreAt > deleteAt, 'restoring the key early would collide with the unique index')
})

test('writes are blocked while the plan runs', () => {
  assert.match(merge, /LOCK TABLE public\.customers IN SHARE ROW EXCLUSIVE MODE/)
})

test('the credits screen sends the picked id to the RPC', () => {
  assert.match(credits, /p_customer_id: form\.customer\.id/)
  assert.match(credits, /p_name: form\.customer\.name/)
  assert.match(credits, /p_phone: form\.customer\.phone/)
})

test('the credits screen uses the picker instead of free-text fields', () => {
  assert.match(credits, /import CustomerPicker from '@\/components\/dashboard\/CustomerPicker'/)
  assert.match(credits, /<CustomerPicker\s+tenantId=\{ctx\.tenantId\}/)
  assert.equal(/form\.name/.test(credits), false, 'no leftover free-text name field')
  assert.equal(/form\.phone/.test(credits), false, 'no leftover free-text phone field')
})

test('resetting the form clears the picked id too', () => {
  // A stale id would attach the next debt to the previous customer.
  assert.match(credits, /setForm\(\{ customer: \{ id: null, name: '', phone: '' \}/)
})

test('the picker searches phones as well as names', () => {
  assert.match(picker, /\.or\(`name\.ilike\.\$\{pattern\},phone\.ilike\.\$\{pattern\}`\)/)
})

test('the POS still carries the id through the outbox to the sync RPC', async () => {
  assert.match(modal, /customer_id: customerId/)
  // The split travels verbatim, so the id reaches engine_sync_sale.
  const sync = await read('lib/sync.js')
  assert.match(sync, /p_split: row\.split \|\| null/)
  const local = await read('lib/local-db.js')
  assert.match(local, /split: split \|\| null/)
})

test('engine_sync_sale still prefers an explicit id', async () => {
  const m027 = await sqlOf('supabase/migrations/202611100027_customer_identity.sql')
  const idAt = m027.indexOf("IF nullif(trim(p_split->>'customer_id'),'') IS NOT NULL")
  const phoneAt = m027.indexOf('IF customer_phone IS NOT NULL')
  assert.ok(idAt > 0 && phoneAt > idAt, 'the id branch must precede phone matching')
})

