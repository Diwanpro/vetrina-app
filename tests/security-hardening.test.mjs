import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'

const read = path => fs.readFile(new URL(path, import.meta.url), 'utf8')
const strip = source => source
  .replace(/\s+/g, ' ')
  .replace(/ ?([,)])/g, '$1')
  .replace(/\( ?/g, '(')
  .replace(/ ?\./g, '.')

const migration = await read('../supabase/migrations/202611120011_security_hardening.sql')
const sql = strip(migration)
const files = await fs.readdir(new URL('../supabase/migrations/', import.meta.url))

test('the hardening migration runs after the storefront migrations it hardens', () => {
  // The invariant is ordering, not "this is always the newest file": any later
  // feature migration is expected to lock its own tables, which the next test
  // checks. Pinning it to sorted.at(-1) broke the day a feature was added.
  assert.ok(files.includes('202611120011_security_hardening.sql'))
  const hardening = files.filter(f => f.startsWith('2026111200') || f.startsWith('20261112')).sort()
  const storefront = hardening.filter(f => /ecommerce_phase_a|product_video_link|stock_movements/.test(f))
  assert.ok(storefront.every(f => f < '202611120011_security_hardening.sql'))
})

test('every migration after the hardening one locks the tables it creates', async () => {
  // 011 sweeps the catalogue once; a table created later is not covered by it.
  // This is the trap that makes "hardening runs last" tempting — the real fix
  // is that later migrations are responsible for themselves.
  const later = files.filter(f => f.endsWith('.sql') && f > '202611120011_security_hardening.sql')
  for (const file of later) {
    const text = await fs.readFile(new URL(`../supabase/migrations/${file}`, import.meta.url), 'utf8')
    const created = [...text.matchAll(/CREATE TABLE IF NOT EXISTS public\.(\w+)/g)].map(m => m[1])
    for (const table of created) {
      assert.match(text, new RegExp(`ALTER TABLE public\\.${table}\\s+ENABLE ROW LEVEL SECURITY`),
        `${file}: ${table} must enable RLS`)
      assert.match(text, new RegExp(`REVOKE ALL ON TABLE public\\.${table}`),
        `${file}: ${table} must revoke anon`)
    }
  }
})

test('the tenant helper is definer-only and cannot be called by anon', () => {
  assert.match(sql, /CREATE OR REPLACE FUNCTION public\.current_tenant_id\(\)/)
  assert.match(sql, /SECURITY DEFINER SET search_path = public/)
  assert.match(sql, /SELECT tenant_id FROM public\.users WHERE auth_id = auth\.uid\(\) LIMIT 1/)
  assert.match(sql, /REVOKE ALL ON FUNCTION public\.current_tenant_id\(\) FROM PUBLIC, anon/)
  assert.match(sql, /GRANT EXECUTE ON FUNCTION public\.current_tenant_id\(\) TO authenticated/)
})

test('anon loses every table privilege, present and future', () => {
  assert.match(sql, /REVOKE ALL ON ALL TABLES IN SCHEMA public FROM anon;/)
  assert.match(sql, /REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM anon;/)
  assert.match(sql, /ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM anon;/)
  assert.match(sql, /ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM anon;/)
  // No grant to anon anywhere in the file.
  assert.doesNotMatch(sql, /GRANT [^;]* TO anon/)
})

test('the sweep is driven by the catalogue, not by a list of today\'s tables', () => {
  assert.match(sql, /FROM pg_class c JOIN pg_namespace n ON n\.oid = c\.relnamespace/)
  assert.match(sql, /AND c\.relkind IN \('r', 'p'\)/)
  // The nine tables that prompted this were all missing RLS; none of them is
  // named in a policy statement, so a table added tomorrow is covered too.
  for (const table of ['pending_collections', 'inventory', 'product_variants',
    'products', 'sale_items', 'sales', 'credits', 'customers', 'shifts']) {
    assert.doesNotMatch(sql, new RegExp(`ON public\\.${table}\\b`))
    assert.doesNotMatch(sql, new RegExp(`TABLE public\\.${table}\\b`))
  }
})

test('every table is locked inside the loop', () => {
  assert.match(sql, /EXECUTE format\('ALTER TABLE public\.%I ENABLE ROW LEVEL SECURITY', tbl\.name\)/)
  assert.match(sql, /EXECUTE format\('REVOKE ALL ON TABLE public\.%I FROM anon', tbl\.name\)/)
  assert.match(sql, /total := total \+ 1/)
})

test('a table that already has a policy is left exactly as it was', () => {
  assert.match(sql, /SELECT count\(\*\) INTO existing FROM pg_policies WHERE schemaname = 'public' AND tablename = tbl\.name/)
  assert.match(sql, /CONTINUE WHEN existing > 0/)
})

test('tenant tables are scoped to the caller\'s tenant', () => {
  assert.match(sql, /ELSIF has_tenant THEN expr := 'tenant_id = public\.current_tenant_id\(\)'/)
  assert.match(sql, /expr := format\('id = public\.current_tenant_id\(\)'\)/)
})

test('store tables follow the store back to its tenant', () => {
  assert.match(sql, /ELSIF has_store THEN/)
  // The format string is split over two lines of source, so the collapsed text
  // carries the literal continuation between the two halves.
  assert.match(sql, /EXISTS \(SELECT 1 FROM public\.stores s WHERE s\.id = %I\.store_id ' 'AND s\.tenant_id = public\.current_tenant_id\(\)\)/)
})

test('a table without its own scope inherits it from its parent row', () => {
  for (const pair of ['sale_id', 'order_id', 'product_id', 'variant_id',
    'customer_id', 'credit_id', 'shift_id', 'purchase_id', 'supplier_id']) {
    assert.match(sql, new RegExp(`\\['${pair}', '[a-z_]+'\\]`))
  }
  // The parent lookup starts at the parent's own tenant, then its store.
  assert.match(sql, /AND p\.tenant_id = public\.current_tenant_id\(\)/)
  assert.match(sql, /EXISTS \(SELECT 1 FROM public\.%I p JOIN public\.stores s ON s\.id = p\.store_id/)
  // First match wins, so a child never picks up an unrelated parent.
  assert.match(sql, /EXIT;/)
})

test('a table with no scope at all is denied, and named in a notice', () => {
  assert.match(sql, /IF expr IS NULL THEN locked := locked \|\| tbl\.name::text;/)
  assert.match(sql, /RAISE NOTICE 'RLS hardening: no scope column, access denied until a policy is written: %'/)
})

test('every generated policy covers reads and writes for staff only', () => {
  const created = migration.match(/CREATE POLICY[^']*?FOR ALL TO authenticated USING \(%s\) WITH CHECK \(%s\)/g) || []
  assert.equal(created.length, 4)
  assert.doesNotMatch(sql, /CREATE POLICY [^;]* TO anon/)
  assert.doesNotMatch(sql, /CREATE POLICY [^;]* FOR SELECT TO anon/)
})

test('the audit view proves the database is closed', () => {
  assert.match(sql, /CREATE OR REPLACE VIEW public\.security_audit AS/)
  assert.match(sql, /has_table_privilege\('anon', c\.oid, 'SELECT'\) AS anon_can_read/)
  assert.match(sql, /c\.relrowsecurity AS rls_enabled/)
  assert.match(sql, /REVOKE ALL ON public\.security_audit FROM PUBLIC, anon;/)
  assert.match(sql, /GRANT SELECT ON public\.security_audit TO authenticated;/)
})

test('the public shop reaches the database only through RPCs', async () => {
  for (const path of ['../lib/public-store.js', '../components/store/Storefront.js',
    '../components/store/CartSheet.js', '../components/store/TrackOrder.js',
    '../components/store/ProductSheet.js']) {
    const source = await read(path)
    assert.doesNotMatch(source, /\.from\('/, `${path} must not touch a table directly`)
  }
})

test('re-running the migration cannot weaken a policy', () => {
  // CREATE POLICY only ever runs after the "already has one" guard, so the
  // second run is a no-op instead of an error or a widened policy.
  const createIdx = migration.indexOf('CREATE POLICY')
  const guardIdx = migration.indexOf('CONTINUE WHEN existing > 0')
  assert.ok(guardIdx > 0 && guardIdx < createIdx)
  assert.doesNotMatch(sql, /DROP POLICY/)
})
