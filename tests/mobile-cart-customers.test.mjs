import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'

const read = path => fs.readFile(new URL(path, import.meta.url), 'utf8')
const topbar = await read('../components/dashboard/TopBar.js')
const pos = await read('../app/dashboard/pos/page.js')
const credits = await read('../app/dashboard/_screens/credits.js')
const sql = await read('../supabase/migrations/202611100027_customer_identity.sql')

const fn = (source, name) => {
  const start = source.indexOf(`FUNCTION public.${name}(`)
  assert.ok(start > -1, `${name} missing`)
  const body = source.slice(source.indexOf('AS $$', start))
  return body.slice(0, body.indexOf('$$;'))
}

test('the topbar date is small, single-line and allowed to shrink', () => {
  // min-w-0 + truncate is what prevents the clipping on a narrow phone; without
  // min-w-0 a flex child refuses to shrink below its content width.
  assert.match(topbar, /className="min-w-0 flex-1"/)
  assert.match(topbar, /truncate whitespace-nowrap text-xs text-neutral-100 sm:text-sm/)
})

test('the topbar branch selector goes full width on its own row on mobile', () => {
  assert.match(topbar, /className="order-last w-full min-w-0 sm:order-none sm:w-auto"/)
  assert.match(topbar, /w-full max-w-full .* sm:w-auto sm:max-w-48/)
  // It must not be capped at a fixed width while stacked.
  assert.equal(/className="max-w-48 rounded-lg/.test(topbar), false)
})

test('the mobile sync button shortens its label instead of overflowing', () => {
  assert.match(topbar, /<span className="hidden sm:inline">\{syncing \? 'جاري المزامنة\.\.\.' : 'مزامنة الآن'\}<\/span>/)
  assert.match(topbar, /<span className="sm:hidden">\{syncing \? '\.\.\.' : 'مزامنة'\}<\/span>/)
})

test('the topbar shows a generic store name for non-owners without wrapping', () => {
  assert.match(topbar, /truncate whitespace-nowrap text-xs text-neutral-400/)
})

test('the customers lookup is case-insensitive and whitespace-insensitive', () => {
  // The browser now delegates matching; the server is the single source of truth.
  assert.match(credits, /supabase\.rpc\('engine_create_credit'/)
  assert.equal(/from\('customers'\)\s*\.select/.test(credits), false, 'no client-side customer lookup left')
  assert.equal(/\.eq\('name',/.test(credits), false, 'exact name equality removed')
})

test('the match key normalises whitespace and case in the database', () => {
  const body = fn(sql, 'customer_match_key')
  assert.match(body, /lower/)
  assert.match(body, /regexp_replace\(btrim\(coalesce\(p_name, ''\)\), '\\s\+', ' ', 'g'\)/)
  // IMMUTABLE sits on the declaration, not inside the body; the unique index
  // depends on it being declared that way.
  assert.match(sql, /RETURNS text\s+LANGUAGE sql IMMUTABLE AS \$\$/)
})

test('duplicates are made impossible, not merely avoided', () => {
  assert.match(sql, /CREATE UNIQUE INDEX IF NOT EXISTS customers_tenant_match_key\s+ON public\.customers\(tenant_id, match_key\)/)
  // The index must be filled before it is built, or the create fails.
  const backfill = sql.indexOf('UPDATE public.customers\n     SET match_key')
  const index = sql.indexOf('CREATE UNIQUE INDEX IF NOT EXISTS customers_tenant_match_key')
  assert.ok(backfill > -1 && backfill < index, 'backfill before index')
})

test('a trigger keeps the key correct for every future write', () => {
  assert.match(sql, /CREATE TRIGGER customers_match_key\s+BEFORE INSERT OR UPDATE OF name ON public\.customers/)
  assert.match(sql, /NEW\.match_key := public\.customer_match_key\(NEW\.name\)/)
})

test('the credit sync matches on the key and survives a concurrent insert', () => {
  const body = fn(sql, 'engine_sync_sale')
  assert.match(body, /match_key = public\.customer_match_key\(customer_key\)/)
  assert.match(body, /ON CONFLICT \(tenant_id, match_key\) WHERE match_key IS NOT NULL DO NOTHING/)
  // Losing the race must fall back to reading the winner's row. The test is a
  // boolean, not `customer.id IS NULL`: reading a field of a record that was
  // never assigned raises 55000 "record customer is not assigned yet".
  assert.match(body, /IF NOT found_customer THEN\s+SELECT \* INTO customer FROM public\.customers\s+WHERE tenant_id = p_tenant AND match_key/)
})

test('the manual credit path matches the same way before inserting a debt', () => {
  const body = fn(sql, 'engine_create_credit')
  const matchAt = body.indexOf('match_key = public.customer_match_key(clean_name)')
  const insertCustomer = body.indexOf('INSERT INTO public.customers')
  const insertCredit = body.indexOf('INSERT INTO public.credits')
  assert.ok(matchAt > -1, 'matches by key')
  assert.ok(matchAt < insertCustomer, 'match before creating a customer')
  assert.ok(insertCustomer < insertCredit, 'customer before debt')
  assert.match(body, /created_customer := FOUND/)
})

test('buying one item returns to the catalogue instead of opening payment', () => {
  assert.match(pos, /const \[cartOpen, setCartOpen\] = useState\(false\)/)
  const addAt = pos.indexOf('function addToCart()')
  const block = pos.slice(addAt, addAt + 500)
  assert.match(block, /setSelected\(null\)/)
  assert.match(block, /setCartOpen\(false\); setCheckout\(false\)/)
  assert.equal(/setCheckout\(true\)/.test(block), false, 'adding must not open checkout')
})

test('the floating bar states the count and total and opens the cart', () => {
  assert.match(pos, /عرض السلة \(\{totals\.count\} قطع\) - \{formatDzd\(totals\.amount\)\}/)
  assert.match(pos, /onClick=\{\(\) => setCartOpen\(true\)\}/)
  // It must be hidden while the cart or payment screen is open.
  assert.match(pos, /\{cart\.length > 0 && !cartOpen && !checkout && \(/)
})

test('the cart step edits quantities, removes lines, and only then pays', () => {
  const cartAt = pos.indexOf('{cartOpen && (')
  assert.ok(cartAt > -1, 'cart modal exists')
  const block = pos.slice(cartAt, pos.indexOf('{checkout && ('))
  assert.match(block, /إنقاص كمية/)
  assert.match(block, /زيادة كمية/)
  assert.match(block, /حذف/)
  assert.match(block, /متابعة للدفع/)
  assert.match(block, /setCartOpen\(false\); setCheckout\(true\)/)
})

test('removing the last line closes the cart and the payment screen', () => {
  const cartAt = pos.indexOf('{cartOpen && (')
  const block = pos.slice(cartAt, pos.indexOf('{checkout && ('))
  assert.match(block, /if \(!next\.length\) \{ setCartOpen\(false\); setCheckout\(false\) \}/)
})

test('payment can step back to the cart without losing the sale', () => {
  assert.match(pos, /setCheckout\(false\); setCartOpen\(true\)/)
  assert.match(pos, /رجوع للسلة/)
})

test('the duplicate backfill is set-based, not a mutating loop', () => {
  // A loop that updates the table it is selecting from can re-see rewritten rows
  // and suffix the same customer twice. One statement cannot do that.
  const doBlock = sql.slice(sql.indexOf('DO $$'), sql.indexOf('$$;', sql.indexOf('DO $$')))
  assert.equal(/FOR duplicate IN/.test(doBlock), false, 'no row-by-row loop over the mutated table')
  assert.match(doBlock, /WITH ranked AS \(/)
  assert.match(doBlock, /UPDATE public\.customers target\s+SET match_key = ranked\.match_key \|\| '#' \|\| ranked\.id::text/)
})

test('the backfill never moves or merges money', () => {
  // It only rewrites customers.match_key; credits are never touched, because
  // silently reassigning someone's debt is worse than a duplicate row.
  assert.equal(/UPDATE public\.credits/.test(sql), false)
  assert.equal(/DELETE FROM public\.customers/.test(sql), false)
})
