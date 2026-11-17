// Isolated PostgreSQL WASM, never Supabase/Live. The fixture reproduces the
// documented live schema (supabase/schema/columns.tsv plus the migrations) and
// the wide policies that were found on the live database, then applies the
// hardening migrations and asserts behaviour. It proves the policy SQL and the
// privilege changes; it does not prove Supabase Auth/Storage behaviour.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { PGlite } from '@electric-sql/pglite'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const MIGRATIONS = path.join(ROOT, 'supabase', 'migrations')

// Fixed UUIDs so a failure message can name the exact actor.
const ID = {
  ta: '00000000-0000-0000-0000-0000000000a1',
  tb: '00000000-0000-0000-0000-0000000000b2',
  sa1: '00000000-0000-0000-0000-0000000000a3',
  sa2: '00000000-0000-0000-0000-0000000000a4',
  sb1: '00000000-0000-0000-0000-0000000000b5',
  oa: '00000000-0000-0000-0000-0000000000a6',
  ma: '00000000-0000-0000-0000-0000000000a7',
  ea: '00000000-0000-0000-0000-0000000000a8',
  ea2: '00000000-0000-0000-0000-0000000000af',
  ob: '00000000-0000-0000-0000-0000000000b6',
  mb: '00000000-0000-0000-0000-0000000000b7',
  eb: '00000000-0000-0000-0000-0000000000b8',
  ca1: '00000000-0000-0000-0000-0000000000a9',
  ca2: '00000000-0000-0000-0000-0000000000aa',
  cb1: '00000000-0000-0000-0000-0000000000b9',
  pa: '00000000-0000-0000-0000-0000000000ab',
  pb: '00000000-0000-0000-0000-0000000000bb',
  va: '00000000-0000-0000-0000-0000000000ac',
  vb: '00000000-0000-0000-0000-0000000000bc',
  sale_a1: '00000000-0000-0000-0000-0000000000ad',
  sale_a2: '00000000-0000-0000-0000-0000000000ae',
  sale_a3: '00000000-0000-0000-0000-0000000000c1',
  sale_b1: '00000000-0000-0000-0000-0000000000bd'
}

const SCHEMA = `
CREATE ROLE anon;
CREATE ROLE authenticated;
CREATE ROLE service_role;

CREATE SCHEMA auth;
GRANT USAGE ON SCHEMA auth TO anon, authenticated;
CREATE FUNCTION auth.uid() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('request.jwt.claim.sub', true), '')::uuid
$$;
GRANT EXECUTE ON FUNCTION auth.uid() TO anon, authenticated;

CREATE TABLE public.tenants(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  phone text,
  is_active boolean NOT NULL DEFAULT false,
  is_activated boolean NOT NULL DEFAULT false,
  subscription_plan text,
  subscription_end_date timestamptz,
  trial_start_date timestamptz,
  branches_limit integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.stores(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id),
  name text NOT NULL
);
CREATE TABLE public.users(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id),
  store_id uuid REFERENCES public.stores(id),
  username text NOT NULL,
  role text NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  auth_id uuid NOT NULL,
  full_name text
);
CREATE TABLE public.customers(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id),
  name text NOT NULL,
  phone text,
  created_at timestamptz NOT NULL DEFAULT now(),
  credit_limit integer,
  loyalty_points integer,
  match_key text
);
CREATE TABLE public.products(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id),
  name text NOT NULL,
  base_price integer NOT NULL DEFAULT 0,
  price numeric NOT NULL DEFAULT 0
);
CREATE TABLE public.product_variants(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id uuid NOT NULL REFERENCES public.products(id),
  size text,
  color text,
  sku text,
  cost_price_avg numeric,
  min_price integer,
  barcode text
);
CREATE TABLE public.inventory(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id uuid NOT NULL REFERENCES public.stores(id),
  variant_id uuid NOT NULL REFERENCES public.product_variants(id),
  quantity integer NOT NULL DEFAULT 0,
  reserved_qty integer
);
CREATE TABLE public.sales(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id uuid NOT NULL REFERENCES public.stores(id),
  user_id uuid,
  total_amount integer NOT NULL DEFAULT 0,
  discount_amount integer,
  status text,
  created_at timestamptz NOT NULL DEFAULT now(),
  discount numeric NOT NULL DEFAULT 0,
  payment_method text NOT NULL DEFAULT 'cash',
  note text,
  synced_at timestamptz,
  local_id text,
  sync_items jsonb,
  cash_amount bigint NOT NULL DEFAULT 0
);
CREATE TABLE public.sale_items(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sale_id uuid NOT NULL REFERENCES public.sales(id),
  variant_id uuid NOT NULL REFERENCES public.product_variants(id),
  quantity integer NOT NULL,
  original_price integer NOT NULL DEFAULT 0,
  final_price integer NOT NULL DEFAULT 0,
  price_changed_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  unit_price numeric NOT NULL DEFAULT 0,
  subtotal numeric NOT NULL DEFAULT 0,
  cost_at_sale numeric,
  offer_id uuid
);

ALTER TABLE public.tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.stores ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.customers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.products ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.product_variants ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.inventory ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sales ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sale_items ENABLE ROW LEVEL SECURITY;

-- Supabase's default: authenticated can do everything on public tables.
GRANT ALL ON ALL TABLES IN SCHEMA public TO authenticated;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO authenticated;

CREATE FUNCTION public.current_staff() RETURNS SETOF public.users
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT * FROM public.users WHERE auth_id = auth.uid() AND is_active LIMIT 1
$$;
CREATE FUNCTION public.current_tenant_id() RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT tenant_id FROM public.users WHERE auth_id = auth.uid() LIMIT 1
$$;

-- The wide policies that were found on the live database.
CREATE POLICY customers_select ON public.customers
  FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY tenant_isolation ON public.tenants
  FOR ALL TO authenticated
  USING (id = public.current_tenant_id())
  WITH CHECK (id = public.current_tenant_id());
CREATE POLICY sales_select ON public.sales
  FOR SELECT TO authenticated USING (true);
CREATE POLICY sales_insert ON public.sales
  FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY sale_items_select ON public.sale_items
  FOR SELECT TO authenticated USING (true);
CREATE POLICY sale_items_insert ON public.sale_items
  FOR INSERT TO authenticated WITH CHECK (true);

-- The live database gives authenticated a tenant-scoped read on the catalogue
-- and the branch directory; the sales / sale_items policies join those tables,
-- so without a policy the join sees nothing.
CREATE POLICY stores_tenant_read ON public.stores
  FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.current_staff() u WHERE u.tenant_id = stores.tenant_id));
CREATE POLICY products_tenant_read ON public.products
  FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.current_staff() u WHERE u.tenant_id = products.tenant_id));
CREATE POLICY product_variants_tenant_read ON public.product_variants
  FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.products p
      JOIN public.current_staff() u ON u.tenant_id = p.tenant_id
     WHERE p.id = product_variants.product_id
  ));
CREATE POLICY inventory_tenant_read ON public.inventory
  FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.stores s
      JOIN public.current_staff() u ON u.tenant_id = s.tenant_id
     WHERE s.id = inventory.store_id
  ));

-- Stand-ins for the real SECURITY DEFINER entry points. They exist to prove
-- that revoking the direct privilege on authenticated does not break the
-- server-side paths (customer creation, activation, sale sync).
CREATE FUNCTION public.fixture_create_customer(p_tenant uuid, p_name text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE result uuid;
BEGIN
  INSERT INTO public.customers(tenant_id, name) VALUES (p_tenant, p_name) RETURNING id INTO result;
  RETURN result;
END $$;
CREATE FUNCTION public.fixture_activate(p_tenant uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  UPDATE public.tenants SET is_active = true, is_activated = true, subscription_plan = 'lifetime'
   WHERE id = p_tenant;
END $$;
CREATE FUNCTION public.fixture_sync_sale(p_store uuid, p_user uuid, p_variant uuid, p_qty integer) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_sale uuid;
BEGIN
  INSERT INTO public.sales(store_id, user_id, total_amount, payment_method, status, cash_amount, local_id)
  VALUES (p_store, p_user, 1000 * p_qty, 'cash', 'completed', 1000 * p_qty, 'fx-' || gen_random_uuid()::text)
  RETURNING id INTO v_sale;
  INSERT INTO public.sale_items(sale_id, variant_id, quantity, original_price, final_price, unit_price, subtotal)
  VALUES (v_sale, p_variant, p_qty, 1000, 1000, 1000, 1000 * p_qty);
  UPDATE public.inventory SET quantity = quantity - p_qty WHERE store_id = p_store AND variant_id = p_variant;
  RETURN v_sale;
END $$;
`

const DATA = `
INSERT INTO public.tenants(id, name, is_active, is_activated, subscription_plan, branches_limit)
VALUES ('${ID.ta}', '[fixture] Tenant A', true, true, 'lifetime', 10),
       ('${ID.tb}', '[fixture] Tenant B', true, true, 'lifetime', 10);

INSERT INTO public.stores(id, tenant_id, name)
VALUES ('${ID.sa1}', '${ID.ta}', '[fixture] A1'),
       ('${ID.sa2}', '${ID.ta}', '[fixture] A2'),
       ('${ID.sb1}', '${ID.tb}', '[fixture] B1');

INSERT INTO public.users(id, tenant_id, store_id, username, role, is_active, auth_id, full_name)
VALUES ('${ID.oa}', '${ID.ta}', NULL, 'owner_a', 'owner', true, '${ID.oa}', 'Owner A'),
       ('${ID.ma}', '${ID.ta}', '${ID.sa1}', 'manager_a', 'manager', true, '${ID.ma}', 'Manager A'),
       ('${ID.ea}', '${ID.ta}', '${ID.sa1}', 'employee_a', 'employee', true, '${ID.ea}', 'Employee A'),
       ('${ID.ea2}', '${ID.ta}', '${ID.sa1}', 'employee_a2', 'employee', true, '${ID.ea2}', 'Employee A2'),
       ('${ID.ob}', '${ID.tb}', NULL, 'owner_b', 'owner', true, '${ID.ob}', 'Owner B'),
       ('${ID.mb}', '${ID.tb}', '${ID.sb1}', 'manager_b', 'manager', true, '${ID.mb}', 'Manager B'),
       ('${ID.eb}', '${ID.tb}', '${ID.sb1}', 'employee_b', 'employee', true, '${ID.eb}', 'Employee B');

INSERT INTO public.customers(id, tenant_id, name, phone)
VALUES ('${ID.ca1}', '${ID.ta}', '[fixture] Customer A1', '0500000001'),
       ('${ID.ca2}', '${ID.ta}', '[fixture] Customer A2', '0500000002'),
       ('${ID.cb1}', '${ID.tb}', '[fixture] Customer B1', '0600000001');

INSERT INTO public.products(id, tenant_id, name, base_price, price)
VALUES ('${ID.pa}', '${ID.ta}', '[fixture] Product A', 1000, 1000),
       ('${ID.pb}', '${ID.tb}', '[fixture] Product B', 1000, 1000);

INSERT INTO public.product_variants(id, product_id, size, color)
VALUES ('${ID.va}', '${ID.pa}', 'M', 'black'),
       ('${ID.vb}', '${ID.pb}', 'M', 'black');

INSERT INTO public.inventory(store_id, variant_id, quantity)
VALUES ('${ID.sa1}', '${ID.va}', 100),
       ('${ID.sb1}', '${ID.vb}', 100);

INSERT INTO public.sales(id, store_id, user_id, total_amount, payment_method, status, cash_amount, local_id)
VALUES ('${ID.sale_a1}', '${ID.sa1}', '${ID.ea}', 1000, 'cash', 'completed', 1000, 'fx-a1'),
       ('${ID.sale_a2}', '${ID.sa2}', '${ID.ma}', 2000, 'cash', 'completed', 2000, 'fx-a2'),
       ('${ID.sale_a3}', '${ID.sa1}', '${ID.ea2}', 1500, 'cash', 'completed', 1500, 'fx-a3'),
       ('${ID.sale_b1}', '${ID.sb1}', '${ID.eb}', 3000, 'cash', 'completed', 3000, 'fx-b1');

INSERT INTO public.sale_items(sale_id, variant_id, quantity, original_price, final_price, unit_price, subtotal)
VALUES ('${ID.sale_a1}', '${ID.va}', 1, 1000, 1000, 1000, 1000),
       ('${ID.sale_a2}', '${ID.va}', 2, 1000, 1000, 1000, 2000),
       ('${ID.sale_a3}', '${ID.va}', 1, 1500, 1500, 1500, 1500),
       ('${ID.sale_b1}', '${ID.vb}', 3, 1000, 1000, 1000, 3000);
`

async function setup () {
  const db = new PGlite()
  await db.exec(SCHEMA)
  await db.exec(await fs.readFile(path.join(MIGRATIONS, '202611170001_sales_sale_items_rls.sql'), 'utf8'))
  await db.exec(await fs.readFile(path.join(MIGRATIONS, '202611170002_customers_tenants_privileges.sql'), 'utf8'))
  await db.exec(DATA)
  return db
}

async function as (db, authId, fn) {
  await db.query('SELECT set_config(\'request.jwt.claim.sub\', $1, false)', [authId])
  try { return await fn() } finally {
    await db.query('SELECT set_config(\'request.jwt.claim.sub\', \'\', false)')
  }
}

async function expectDenied (fn, label) {
  let error = null
  try { await fn() } catch (err) { error = err }
  assert.ok(error, `${label}: expected the statement to be refused`)
  assert.equal(error.code, '42501', `${label}: expected a privilege/RLS refusal, got ${error.code} ${error.message}`)
}

test('customers and tenants are isolated per tenant, and direct writes are refused', async () => {
  const db = await setup()
  try {
    await db.exec('SET ROLE authenticated')

    // ------------------------------------------------------------ customers
    await as(db, ID.oa, async () => {
      const rows = (await db.query('SELECT id FROM public.customers ORDER BY id')).rows
      assert.deepEqual(rows.map(r => r.id), [ID.ca1, ID.ca2], 'owner A must see only tenant A customers')
    })
    await as(db, ID.ob, async () => {
      const rows = (await db.query('SELECT id FROM public.customers')).rows
      assert.deepEqual(rows.map(r => r.id), [ID.cb1], 'owner B must see only tenant B customers')
    })
    await as(db, ID.ea, async () => {
      const rows = (await db.query('SELECT id FROM public.customers')).rows
      assert.equal(rows.length, 2, 'employee A may read the tenant customers')
    })
    await as(db, ID.oa, async () => {
      await expectDenied(() => db.query(
        'INSERT INTO public.customers(tenant_id, name) VALUES ($1, \'x\')', [ID.ta]), 'customer insert')
      await expectDenied(() => db.query(
        'UPDATE public.customers SET name = \'x\' WHERE id = $1', [ID.ca1]), 'customer update')
      await expectDenied(() => db.query(
        'DELETE FROM public.customers WHERE id = $1', [ID.ca1]), 'customer delete')
      await expectDenied(() => db.query('TRUNCATE public.customers'), 'customer truncate')
    })

    // -------------------------------------------------------------- tenants
    await as(db, ID.oa, async () => {
      const rows = (await db.query('SELECT id FROM public.tenants')).rows
      assert.deepEqual(rows.map(r => r.id), [ID.ta], 'owner A must see only its own tenant')
    })
    await as(db, ID.oa, async () => {
      await expectDenied(() => db.query(
        'UPDATE public.tenants SET is_active = false WHERE id = $1', [ID.ta]), 'tenant self-deactivate')
      await expectDenied(() => db.query(
        'UPDATE public.tenants SET branches_limit = 99 WHERE id = $1', [ID.ta]), 'tenant branch-limit change')
      await expectDenied(() => db.query(
        'UPDATE public.tenants SET subscription_plan = \'lifetime\' WHERE id = $1', [ID.ta]), 'tenant plan change')
      await expectDenied(() => db.query(
        'DELETE FROM public.tenants WHERE id = $1', [ID.ta]), 'tenant delete')
      await expectDenied(() => db.query('TRUNCATE public.tenants'), 'tenant truncate')
    })
    await as(db, ID.ob, async () => {
      await expectDenied(() => db.query(
        'UPDATE public.tenants SET is_active = false WHERE id = $1', [ID.ta]), 'cross-tenant tenant update')
    })

    // -------------------------------------------------------- TRUNCATE sweep
    const tables = (await db.query(
      "SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace " +
      "WHERE n.nspname = 'public' AND c.relkind IN ('r','p') ORDER BY c.relname")).rows
    assert.ok(tables.length >= 9, 'expected the fixture tables')
    for (const { relname } of tables) {
      await expectDenied(() => db.query(`TRUNCATE public.${relname}`), `truncate ${relname}`)
    }
  } finally {
    await db.close()
  }
})

test('sales and sale_items stay scoped to the caller tenant and branch', async () => {
  const db = await setup()
  try {
    await db.exec('SET ROLE authenticated')

    await as(db, ID.oa, async () => {
      const rows = (await db.query('SELECT id FROM public.sales ORDER BY id')).rows
      assert.deepEqual(rows.map(r => r.id), [ID.sale_a1, ID.sale_a2, ID.sale_a3], 'owner A sees every tenant-A sale')
      const items = (await db.query('SELECT sale_id FROM public.sale_items ORDER BY sale_id')).rows
      assert.equal(items.length, 3, 'owner A sees every tenant-A item')
    })
    await as(db, ID.ma, async () => {
      const rows = (await db.query('SELECT id FROM public.sales ORDER BY id')).rows
      assert.deepEqual(rows.map(r => r.id), [ID.sale_a1, ID.sale_a3], 'manager A sees store A1, not store A2')
    })
    // The colleague's sale is in the same store: the employee must see it. This
    // is the assertion that fails under the old "own sales only" condition.
    await as(db, ID.ea, async () => {
      const rows = (await db.query('SELECT id FROM public.sales ORDER BY id')).rows
      assert.deepEqual(rows.map(r => r.id), [ID.sale_a1, ID.sale_a3], 'employee A sees the whole assigned store')
      const items = (await db.query('SELECT sale_id FROM public.sale_items ORDER BY sale_id')).rows
      assert.deepEqual(items.map(r => r.sale_id), [ID.sale_a1, ID.sale_a3], 'employee A sees items of the whole assigned store')
    })
    // Other branches and other tenants stay closed.
    await as(db, ID.ea, async () => {
      const otherBranch = (await db.query('SELECT id FROM public.sales WHERE id = $1', [ID.sale_a2])).rows
      assert.deepEqual(otherBranch, [], 'employee A must not read another branch')
      const otherTenant = (await db.query('SELECT id FROM public.sales WHERE id = $1', [ID.sale_b1])).rows
      assert.deepEqual(otherTenant, [], 'employee A must not read another tenant')
      const otherBranchItems = (await db.query('SELECT sale_id FROM public.sale_items WHERE sale_id = $1', [ID.sale_a2])).rows
      assert.deepEqual(otherBranchItems, [], 'employee A must not read items of another branch')
      const otherTenantItems = (await db.query('SELECT sale_id FROM public.sale_items WHERE sale_id = $1', [ID.sale_b1])).rows
      assert.deepEqual(otherTenantItems, [], 'employee A must not read items of another tenant')
    })
    await as(db, ID.ob, async () => {
      const rows = (await db.query('SELECT id FROM public.sales')).rows
      assert.deepEqual(rows.map(r => r.id), [ID.sale_b1], 'owner B sees only tenant B')
    })
    await as(db, ID.ea, async () => {
      await expectDenied(() => db.query(
        'INSERT INTO public.sales(store_id, user_id, total_amount) VALUES ($1, $2, 1)', [ID.sa1, ID.ea]), 'sale insert')
      await expectDenied(() => db.query(
        'UPDATE public.sales SET total_amount = 0 WHERE id = $1', [ID.sale_a1]), 'sale update')
      await expectDenied(() => db.query(
        'DELETE FROM public.sale_items WHERE sale_id = $1', [ID.sale_a1]), 'sale_items delete')
      await expectDenied(() => db.query('TRUNCATE public.sales'), 'sale truncate')
      await expectDenied(() => db.query('TRUNCATE public.sale_items'), 'sale_items truncate')
    })
  } finally {
    await db.close()
  }
})

test('the SECURITY DEFINER entry points still work after the revoke', async () => {
  const db = await setup()
  try {
    await db.exec('SET ROLE authenticated')

    // A customer created through the RPC is visible to its tenant and not to
    // the other tenant, even though `authenticated` has no INSERT privilege.
    let created = null
    await as(db, ID.oa, async () => {
      created = (await db.query(
        'SELECT public.fixture_create_customer($1, $2) AS id', [ID.ta, '[fixture] RPC customer'])).rows[0].id
      const rows = (await db.query('SELECT id FROM public.customers WHERE id = $1', [created])).rows
      assert.equal(rows.length, 1, 'owner A must see the customer created by the RPC')
    })
    await as(db, ID.ob, async () => {
      const rows = (await db.query('SELECT id FROM public.customers WHERE id = $1', [created])).rows
      assert.equal(rows.length, 0, 'owner B must not see a tenant-A customer')
    })

    // Activation through the RPC still writes the tenant row.
    await db.exec('RESET ROLE')
    await db.query('UPDATE public.tenants SET is_active = false WHERE id = $1', [ID.ta])
    await db.exec('SET ROLE authenticated')
    await as(db, ID.oa, async () => {
      await db.query('SELECT public.fixture_activate($1)', [ID.ta])
    })
    await db.exec('RESET ROLE')
    const activated = (await db.query('SELECT is_active FROM public.tenants WHERE id = $1', [ID.ta])).rows[0]
    assert.equal(activated.is_active, true, 'the activation RPC must still write the tenant row')

    // A sale synced through the RPC writes the sale, the item and the stock.
    await db.exec('SET ROLE authenticated')
    await as(db, ID.ea, async () => {
      const before = (await db.query(
        'SELECT quantity FROM public.inventory WHERE store_id = $1 AND variant_id = $2', [ID.sa1, ID.va])).rows[0].quantity
      const saleId = (await db.query(
        'SELECT public.fixture_sync_sale($1, $2, $3, 2) AS id', [ID.sa1, ID.ea, ID.va])).rows[0].id
      const after = (await db.query(
        'SELECT quantity FROM public.inventory WHERE store_id = $1 AND variant_id = $2', [ID.sa1, ID.va])).rows[0].quantity
      assert.equal(after, before - 2, 'the sale RPC must still deduct stock')
      const items = (await db.query('SELECT sale_id FROM public.sale_items WHERE sale_id = $1', [saleId])).rows
      assert.equal(items.length, 1, 'the sale RPC must still write the sale item')
    })
  } finally {
    await db.close()
  }
})

test('the hardening is idempotent and leaves no wide policy behind', async () => {
  const db = await setup()
  try {
    const snapshot = async () => {
      const policies = (await db.query(
        "SELECT tablename, policyname, cmd FROM pg_policies WHERE schemaname = 'public' ORDER BY tablename, policyname")).rows
      const grants = (await db.query(
        "SELECT c.relname, has_table_privilege('authenticated', c.oid, 'TRUNCATE') AS trunc " +
        "FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace " +
        "WHERE n.nspname = 'public' AND c.relkind IN ('r','p') ORDER BY c.relname")).rows
      return JSON.stringify({ policies, grants })
    }
    const before = await snapshot()
    await db.exec(await fs.readFile(path.join(MIGRATIONS, '202611170001_sales_sale_items_rls.sql'), 'utf8'))
    await db.exec(await fs.readFile(path.join(MIGRATIONS, '202611170002_customers_tenants_privileges.sql'), 'utf8'))
    assert.equal(await snapshot(), before, 're-applying the migrations must not change the catalogue')

    const wide = (await db.query(
      "SELECT tablename, policyname FROM pg_policies WHERE schemaname = 'public' " +
      "AND tablename IN ('customers','tenants','sales','sale_items') " +
      "AND coalesce(qual,'') NOT LIKE '%current_staff%' AND coalesce(with_check,'') NOT LIKE '%current_staff%'")).rows
    assert.deepEqual(wide, [], 'no policy on the hardened tables may be unscoped')

    const anon = (await db.query(
      "SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace " +
      "WHERE n.nspname = 'public' AND c.relkind IN ('r','p') " +
      "AND has_table_privilege('anon', c.oid, 'SELECT')")).rows
    assert.deepEqual(anon, [], 'anon must not read any public table')
  } finally {
    await db.close()
  }
})
