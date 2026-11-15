import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'

const sql = await fs.readFile(
  new URL('../supabase/migrations/202611120015_shipping_integrations.sql', import.meta.url),
  'utf8',
)
const snapshotSql = await fs.readFile(
  new URL('../supabase/migrations/202611120016_shipping_order_snapshot.sql', import.meta.url),
  'utf8',
)

const TABLES = [
  'shipping_connections', 'shipments', 'shipment_events',
  'shipping_export_batches', 'shipping_export_items', 'shipping_territories',
]

test('every new table locks itself (011 swept the catalogue only once)', () => {
  for (const table of TABLES) {
    assert.match(sql, new RegExp(`CREATE TABLE IF NOT EXISTS public\\.${table}\\b`))
    assert.match(sql, new RegExp(`ALTER TABLE public\\.${table}\\s+ENABLE ROW LEVEL SECURITY`))
    assert.match(sql, new RegExp(`REVOKE ALL ON TABLE public\\.${table}\\b`))
  }
})

test('the approved constraint: public.orders is never modified', () => {
  assert.doesNotMatch(sql, /ALTER\s+TABLE\s+public\.orders\b/i)
  assert.doesNotMatch(sql, /UPDATE\s+public\.orders\b/i)
  assert.doesNotMatch(sql, /INSERT\s+INTO\s+public\.orders\b/i)
  assert.doesNotMatch(sql, /DELETE\s+FROM\s+public\.orders\b/i)
  // Foreign keys FROM the new tables are fine; they add no column to orders.
  assert.match(sql, /order_id\s+uuid NOT NULL REFERENCES public\.orders\(id\)/)
})

test('the secret table has no authenticated read path at all', () => {
  assert.match(sql, /REVOKE ALL ON TABLE public\.shipping_connections FROM PUBLIC, anon, authenticated;/)
  assert.match(sql, /GRANT ALL ON TABLE public\.shipping_connections TO service_role;/)
  assert.doesNotMatch(sql, /GRANT SELECT ON TABLE public\.shipping_connections TO authenticated/)
  assert.doesNotMatch(sql, /CREATE POLICY[^\n]*ON public\.shipping_connections\b/)
  assert.doesNotMatch(sql, /GRANT [^\n]* TO anon\b/)
})

test('non-secret tables are read-only and tenant-scoped for staff', () => {
  for (const table of TABLES.slice(1)) {
    assert.match(sql, new RegExp(`GRANT SELECT ON TABLE public\\.${table} TO authenticated;`))
  }
  assert.match(sql, /FOR SELECT TO authenticated USING \(tenant_id = public\.current_tenant_id\(\)\)/)
  assert.match(sql, /shipping_shipments_read/)
  assert.match(sql, /shipping_territories_read/)
  assert.doesNotMatch(sql, /FOR ALL TO authenticated/)
})

test('masked RPCs expose the hint but never the ciphertext', () => {
  for (const name of ['engine_list_shipping_connections', 'engine_list_shipments']) {
    const start = sql.indexOf(`FUNCTION public.${name}(`)
    assert.ok(start > -1, `${name} is missing`)
    const body = sql.slice(start, sql.indexOf('END $$;', start))
    assert.match(body, /SECURITY DEFINER SET search_path = public/)
    assert.doesNotMatch(body, /credentials_ciphertext/)
    assert.match(sql, new RegExp(`REVOKE ALL ON FUNCTION public\\.${name}\\(uuid\\) FROM PUBLIC, anon;`))
    assert.match(sql, new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${name}\\(uuid\\) TO authenticated;`))
  }
  const connections = sql.slice(
    sql.indexOf('FUNCTION public.engine_list_shipping_connections('),
    sql.indexOf('END $$;', sql.indexOf('FUNCTION public.engine_list_shipping_connections(')),
  )
  assert.match(connections, /'credentials_hint', c\.credentials_hint/)
  assert.match(connections, /u\.role NOT IN \('owner','manager'\)/)
  assert.match(connections, /c\.tenant_id = v_tenant/)
})

test('P3 snapshot RPC is read-only, definer-scoped and never alters orders', () => {
  assert.match(snapshotSql, /CREATE OR REPLACE FUNCTION public\.engine_order_shipping_snapshot\(p_order_id uuid\)/)
  assert.match(snapshotSql, /RETURNS jsonb[\s\S]*?SECURITY DEFINER SET search_path = public/)
  assert.match(snapshotSql, /STABLE SECURITY DEFINER/)
  assert.match(snapshotSql, /FROM public\.orders WHERE id = p_order_id/)
  assert.match(snapshotSql, /FROM public\.order_items i WHERE i\.order_id = o\.id/)
  assert.match(snapshotSql, /o\.tenant_id IS DISTINCT FROM u\.tenant_id/)
  assert.match(snapshotSql, /u\.role <> 'owner' AND u\.store_id IS DISTINCT FROM o\.store_id/)
  assert.match(snapshotSql, /REVOKE ALL ON FUNCTION public\.engine_order_shipping_snapshot\(uuid\) FROM PUBLIC, anon;/)
  assert.match(snapshotSql, /GRANT EXECUTE ON FUNCTION public\.engine_order_shipping_snapshot\(uuid\) TO authenticated;/)
  for (const forbidden of [
    /ALTER\s+TABLE\s+public\.orders\b/i,
    /UPDATE\s+public\.orders\b/i,
    /INSERT\s+INTO\s+public\.orders\b/i,
    /DELETE\s+FROM\s+public\.orders\b/i,
    /CREATE\s+(OR REPLACE\s+)?TRIGGER\b/i,
    /CREATE\s+POLICY\b/i,
  ]) {
    assert.doesNotMatch(snapshotSql, forbidden)
  }
})

test('idempotency, uniqueness and canonical statuses are enforced', () => {
  assert.match(sql, /CREATE UNIQUE INDEX IF NOT EXISTS shipping_connections_scope/)
  assert.match(sql, /CREATE UNIQUE INDEX IF NOT EXISTS shipments_active_per_order[\s\S]*?WHERE status NOT IN \('cancelled','failed'\)/)
  assert.match(sql, /CREATE UNIQUE INDEX IF NOT EXISTS shipments_idempotency/)
  assert.match(sql, /CREATE UNIQUE INDEX IF NOT EXISTS shipment_events_key/)
  assert.match(sql, /CREATE UNIQUE INDEX IF NOT EXISTS shipping_export_items_batch_order/)
  assert.match(sql, /shipments_status_check[\s\S]*?'exported','failed'/)
  assert.match(sql, /shipping_connections_credentials_check[\s\S]{0,320}?enabled = false/)
  // Disabling a connection wipes the secret; the CHECK must permit that row.
  assert.match(sql, /provider_code ~ '\^\[a-z0-9_\]\{2,40\}\$'/)
  assert.equal(sql.split('$$').length % 2, 1, 'dollar-quoted blocks must be balanced')
})
