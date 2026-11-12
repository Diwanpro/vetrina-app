import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'

// Phase A is database-only, so these guards watch the invariants that the
// storefront's security depends on. They were checked against a real
// PostgreSQL 16 before being committed here.
const sql = await fs.readFile(
  new URL('../supabase/migrations/202611120005_ecommerce_phase_a.sql', import.meta.url), 'utf8')

// Comments quote column names; strip them before matching executable SQL.
const code = sql.split('\n').filter(line => !line.trim().startsWith('--')).join('\n')

test('the schema uses tenant_id and store_id, never owner_id or branch_id', () => {
  assert.doesNotMatch(code, /owner_id/)
  assert.doesNotMatch(code, /branch_id/)
  assert.doesNotMatch(code, /public\.branches/)
  assert.match(code, /CREATE TABLE IF NOT EXISTS public\.orders \(/)
  assert.match(code, /tenant_id\s+uuid NOT NULL REFERENCES public\.tenants\(id\)/)
  assert.match(code, /store_id\s+uuid NOT NULL REFERENCES public\.stores\(id\)/)
})

test('the three order tables are closed to clients', () => {
  for (const table of ['orders', 'order_items', 'order_status_history']) {
    assert.match(code, new RegExp(`ALTER TABLE public\\.${table} ENABLE ROW LEVEL SECURITY`), table)
  }
  // No write grant of any kind, and anon never gets table access.
  assert.doesNotMatch(code, /GRANT\s+INSERT[^;]*public\.orders/i)
  assert.doesNotMatch(code, /GRANT\s+UPDATE[^;]*public\.orders/i)
  assert.doesNotMatch(code, /GRANT\s+DELETE[^;]*public\.orders/i)
  assert.doesNotMatch(code, /GRANT\s+SELECT ON TABLE public\.orders[^;]*\banon\b/)
  assert.match(code, /REVOKE ALL ON TABLE public\.orders, public\.order_items, public\.order_status_history\s+FROM PUBLIC, anon, authenticated/)
})

test('tenant isolation goes through current_staff(), not a client claim', () => {
  assert.match(code, /CREATE POLICY orders_tenant_read ON public\.orders\s+FOR SELECT TO authenticated\s+USING \(EXISTS \(SELECT 1 FROM public\.current_staff\(\) u WHERE u\.tenant_id = orders\.tenant_id\)\)/)
  // order_items / history inherit the tenant through their parent order.
  assert.match(code, /CREATE POLICY order_items_tenant_read[\s\S]{0,400}?u\.tenant_id = o\.tenant_id/)
  assert.match(code, /CREATE POLICY order_history_tenant_read[\s\S]{0,400}?u\.tenant_id = o\.tenant_id/)
})

test('the public API is exactly the four storefront functions', () => {
  const publicFns = ['get_store_by_slug(text)', 'get_store_products(uuid)',
    'create_order(uuid,jsonb,jsonb,text)', 'get_order_by_token(text)']
  for (const fn of publicFns) {
    assert.match(code, new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${fn.replace(/[()]/g, '\\$&')} TO anon, authenticated`), fn)
  }
  // Moving an order touches stock and writes a sale: staff only.
  assert.match(code, /GRANT EXECUTE ON FUNCTION public\.update_order_status\(uuid,text,text\) TO authenticated/)
  assert.doesNotMatch(code, /GRANT EXECUTE ON FUNCTION public\.update_order_status[^;]*anon/)
})

test('every RPC is SECURITY DEFINER with a pinned search_path', () => {
  const fns = code.match(/CREATE OR REPLACE FUNCTION public\.(get_store_by_slug|get_store_products|create_order|get_order_by_token|update_order_status)[\s\S]*?SET search_path = public AS \$\$/g) || []
  assert.equal(fns.length, 5, 'all five functions must be definer-rights')
  for (const fn of fns) assert.match(fn, /SECURITY DEFINER/)
})

test('the storefront can never see cost or floor prices', () => {
  const products = code.slice(code.indexOf('CREATE OR REPLACE FUNCTION public.get_store_products'),
    code.indexOf('CREATE OR REPLACE FUNCTION public.create_order'))
  assert.doesNotMatch(products, /cost_price_avg/)
  assert.doesNotMatch(products, /min_price/)
  // Prices are nulled out when the owner hides them.
  assert.match(products, /CASE WHEN coalesce\(s\.show_prices, true\) THEN p\.base_price ELSE NULL END/)
})

test('orders are priced on the server and availability ignores reservations', () => {
  assert.match(code, /coalesce\(p\.base_price, 0\)/)
  assert.match(code, /\(i\.quantity - coalesce\(i\.reserved_qty, 0\)\)/)
  // The client's own numbers are never read.
  assert.doesNotMatch(code, /->>'price'/)
  assert.doesNotMatch(code, /->>'total'/)
  assert.match(code, /IF line_total > gross_total THEN line_total := gross_total; END IF;/)
})

test('stock is reserved on confirm and released before a sale is written', () => {
  const fn = code.slice(code.indexOf('CREATE OR REPLACE FUNCTION public.update_order_status'))
  assert.match(fn, /reserved_qty = coalesce\(reserved_qty, 0\) \+ line\.qty/)
  assert.match(fn, /was_reserved := old_status IN \('confirmed', 'preparing'\)/)
  assert.match(fn, /greatest\(coalesce\(reserved_qty, 0\) - line\.qty, 0\)/)
  // Delivery reuses the till's engine so profit and stock stay consistent.
  assert.match(fn, /created_sale := public\.engine_sync_sale\(/)
})

test('a discounted order can still reach the floor bypass', () => {
  // 202611120004 made offers product-level (variant_id NULL); the engine must
  // accept that, or delivering a discounted order fails on min_price.
  const engine = sql.slice(sql.indexOf('CREATE OR REPLACE FUNCTION public.engine_sync_sale('))
  assert.match(engine, /o\.variant_id IS NULL AND o\.product_id=item_product/)
  assert.match(engine, /o\.variant_id=item\.variant_id/)
})

test('required indexes exist', () => {
  assert.match(code, /CREATE INDEX IF NOT EXISTS orders_store_status ON public\.orders \(store_id, status\)/)
  assert.match(code, /CREATE UNIQUE INDEX IF NOT EXISTS orders_public_token_key ON public\.orders \(public_token\)/)
  assert.match(code, /CREATE UNIQUE INDEX IF NOT EXISTS stores_slug_key\s+ON public\.stores \(lower\(slug\)\) WHERE slug IS NOT NULL/)
})

test('tracking leaks no more than the token holder already knows', () => {
  const fn = code.slice(code.indexOf('CREATE OR REPLACE FUNCTION public.get_order_by_token'),
    code.indexOf('-- --------------------------------------------------------- staff: move an order'))
  assert.match(fn, /left\(o\.customer_phone, 2\) \|\| repeat\('\*'/)
  assert.doesNotMatch(fn, /'address'/)
})
