-- ============================================================================
-- tests/sales-sale-items-isolation.acceptance.sql
--
-- ISOLATED TEST ENVIRONMENT ONLY. Never run this against production
-- (scfwdjbgwlaptbnjkofk). It writes synthetic tenants, staff, stores,
-- products, sales and stock, then rolls everything back.
--
-- Prerequisites
-- -------------
--   * an isolated Supabase project / database branch, proved independent of the
--     production project;
--   * the repository migrations applied, including
--     202611170001_sales_sale_items_rls.sql.
--
-- Run as a superuser (postgres) inside one transaction:
--   psql -f tests/sales-sale-items-isolation.acceptance.sql
-- The file opens BEGIN and closes ROLLBACK itself.
--
-- What it proves (behaviour, not text)
-- ------------------------------------
--   1-4  read isolation per role (owner / manager / employee) and per tenant
--   5-8  direct writes are refused, and the RLS INSERT policies carry the same
--        scope as the read policies (verified by the catalogue checks below)
--   9    direct writes to both tables are refused for authenticated
--   10-11 the six direct privileges are gone, SELECT is kept, anon gets nothing
--   12   the legitimate sale path (engine_sync_sale_for_staff, the one the app
--        calls) still works after the revoke, including atomic stock deduction
--   13   reserved stock is still protected and a refused sale leaves no rows
--   14   replaying the same local_id is still idempotent
--   15   a refused sale leaves no partial sale / item / stock movement
--   16   the sale_items policy really consults stores / products /
--        product_variants (cross-tenant RPC refused, foreign variant refused,
--        staff impersonation refused)
--   17   a deactivated staff member loses access even though
--        current_tenant_id() alone would still resolve
--   18   the four wide policies are gone and no unscoped policy remains
--   19   the dashboard read paths still work (owner / manager / employee)
--   20   re-running the migration is a no-op (checked separately, see the note
--        at the end of this file)
-- ============================================================================

BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '120s';

CREATE TEMP TABLE ssi_state(
  ta uuid, tb uuid,                 -- tenants
  sa1 uuid, sa2 uuid, sb1 uuid,     -- stores (A1, A2 in tenant A; B1 in tenant B)
  oa uuid, ma uuid, ea uuid,        -- tenant A: owner, manager(A1), employee(A1)
  ob uuid, mb uuid, eb uuid,        -- tenant B: owner, manager(B1), employee(B1)
  pa uuid, pb uuid,                 -- products
  va uuid, vb uuid,                 -- variants
  sale_a1 uuid, sale_a2 uuid, sale_b1 uuid
);

INSERT INTO ssi_state(ta, tb, sa1, sa2, sb1, oa, ma, ea, ob, mb, eb, pa, pb, va, vb, sale_a1, sale_a2, sale_b1)
VALUES (gen_random_uuid(), gen_random_uuid(),
        gen_random_uuid(), gen_random_uuid(), gen_random_uuid(),
        gen_random_uuid(), gen_random_uuid(), gen_random_uuid(),
        gen_random_uuid(), gen_random_uuid(), gen_random_uuid(),
        gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), gen_random_uuid(),
        gen_random_uuid(), gen_random_uuid(), gen_random_uuid());

GRANT SELECT, UPDATE ON ssi_state TO authenticated;

-- ------------------------------------------------------------------ tenants
INSERT INTO public.tenants(id, name, is_active, is_activated, subscription_plan, branches_limit)
SELECT ta, '[ssi] Tenant A', true, true, 'lifetime', 10 FROM ssi_state
UNION ALL
SELECT tb, '[ssi] Tenant B', true, true, 'lifetime', 10 FROM ssi_state;

-- ------------------------------------------------------------------- stores
INSERT INTO public.stores(id, tenant_id, name)
SELECT sa1, ta, '[ssi] A1' FROM ssi_state
UNION ALL SELECT sa2, ta, '[ssi] A2' FROM ssi_state
UNION ALL SELECT sb1, tb, '[ssi] B1' FROM ssi_state;

-- ---------------------------------------------------------------- auth users
INSERT INTO auth.users(id, email, raw_app_meta_data, is_sso_user, is_anonymous)
SELECT oa, 'ssi-owner-a@example.test', jsonb_build_object('ssi', 'owner-a'), false, false FROM ssi_state
UNION ALL SELECT ma, 'ssi-manager-a@example.test', jsonb_build_object('ssi', 'manager-a'), false, false FROM ssi_state
UNION ALL SELECT ea, 'ssi-employee-a@example.test', jsonb_build_object('ssi', 'employee-a'), false, false FROM ssi_state
UNION ALL SELECT ob, 'ssi-owner-b@example.test', jsonb_build_object('ssi', 'owner-b'), false, false FROM ssi_state
UNION ALL SELECT mb, 'ssi-manager-b@example.test', jsonb_build_object('ssi', 'manager-b'), false, false FROM ssi_state
UNION ALL SELECT eb, 'ssi-employee-b@example.test', jsonb_build_object('ssi', 'employee-b'), false, false FROM ssi_state;

-- --------------------------------------------------------------------- staff
INSERT INTO public.users(id, tenant_id, store_id, username, role, auth_id, full_name)
SELECT oa, ta, NULL, 'ssi_owner_a', 'owner', oa, '[ssi] Owner A' FROM ssi_state
UNION ALL SELECT ma, ta, sa1, 'ssi_manager_a', 'manager', ma, '[ssi] Manager A' FROM ssi_state
UNION ALL SELECT ea, ta, sa1, 'ssi_employee_a', 'employee', ea, '[ssi] Employee A' FROM ssi_state
UNION ALL SELECT ob, tb, NULL, 'ssi_owner_b', 'owner', ob, '[ssi] Owner B' FROM ssi_state
UNION ALL SELECT mb, tb, sb1, 'ssi_manager_b', 'manager', mb, '[ssi] Manager B' FROM ssi_state
UNION ALL SELECT eb, tb, sb1, 'ssi_employee_b', 'employee', eb, '[ssi] Employee B' FROM ssi_state;

-- ------------------------------------------------------------------ catalogue
INSERT INTO public.products(id, tenant_id, name, base_price, price)
SELECT pa, ta, '[ssi] Product A', 1000, 1000 FROM ssi_state
UNION ALL SELECT pb, tb, '[ssi] Product B', 1000, 1000 FROM ssi_state;

INSERT INTO public.product_variants(id, product_id, size, color, cost_price_avg, min_price)
SELECT va, pa, 'M', 'black', 500, 900 FROM ssi_state
UNION ALL SELECT vb, pb, 'M', 'black', 500, 900 FROM ssi_state;

INSERT INTO public.inventory(store_id, variant_id, quantity)
SELECT sa1, va, 100 FROM ssi_state
UNION ALL SELECT sb1, vb, 100 FROM ssi_state;

-- ------------------------------------------------------------------- history
-- Two tenant-A sales (A1 by the employee, A2 by the manager) and one tenant-B
-- sale, so every read test has a positive and a negative case.
INSERT INTO public.sales(id, store_id, user_id, total_amount, payment_method, status, cash_amount, local_id, created_at)
SELECT sale_a1, sa1, ea, 1000, 'cash', 'completed', 1000, 'ssi-a1', now() FROM ssi_state
UNION ALL SELECT sale_a2, sa2, ma, 2000, 'cash', 'completed', 2000, 'ssi-a2', now() FROM ssi_state
UNION ALL SELECT sale_b1, sb1, eb, 3000, 'cash', 'completed', 3000, 'ssi-b1', now() FROM ssi_state;

INSERT INTO public.sale_items(sale_id, variant_id, quantity, original_price, final_price, unit_price, subtotal)
SELECT sale_a1, va, 1, 1000, 1000, 1000, 1000 FROM ssi_state
UNION ALL SELECT sale_a2, va, 2, 1000, 1000, 1000, 2000 FROM ssi_state
UNION ALL SELECT sale_b1, vb, 3, 1000, 1000, 1000, 3000 FROM ssi_state;

-- ===========================================================================
-- 1-4 + 19  read isolation, as the real roles
-- ===========================================================================
SET LOCAL ROLE authenticated;
DO $$
DECLARE
  s ssi_state%row_type;
  n integer;
BEGIN
  IF current_user <> 'authenticated' THEN RAISE EXCEPTION 'ssi: wrong test role'; END IF;
  SELECT * INTO s FROM ssi_state;

  -- owner A: both tenant-A sales, none from tenant B
  PERFORM set_config('request.jwt.claim.sub', s.oa::text, true);
  SELECT count(*) INTO n FROM public.sales;
  IF n <> 2 THEN RAISE EXCEPTION 'ssi: owner A saw % sales, expected 2', n; END IF;
  IF EXISTS (SELECT 1 FROM public.sales WHERE id = s.sale_b1) THEN
    RAISE EXCEPTION 'ssi: owner A read a foreign-tenant sale'; END IF;

  -- owner A sees both tenant-A sale items
  SELECT count(*) INTO n FROM public.sale_items;
  IF n <> 2 THEN RAISE EXCEPTION 'ssi: owner A saw % items, expected 2', n; END IF;

  -- manager A: only store A1
  PERFORM set_config('request.jwt.claim.sub', s.ma::text, true);
  SELECT count(*) INTO n FROM public.sales;
  IF n <> 1 THEN RAISE EXCEPTION 'ssi: manager A saw % sales, expected 1', n; END IF;
  IF EXISTS (SELECT 1 FROM public.sales WHERE id = s.sale_a2) THEN
    RAISE EXCEPTION 'ssi: manager A read another branch'; END IF;
  SELECT count(*) INTO n FROM public.sale_items;
  IF n <> 1 THEN RAISE EXCEPTION 'ssi: manager A saw % items, expected 1', n; END IF;

  -- employee A: only their own sale, and only its item
  PERFORM set_config('request.jwt.claim.sub', s.ea::text, true);
  SELECT count(*) INTO n FROM public.sales;
  IF n <> 1 THEN RAISE EXCEPTION 'ssi: employee A saw % sales, expected 1', n; END IF;
  IF EXISTS (SELECT 1 FROM public.sales WHERE id = s.sale_a2) THEN
    RAISE EXCEPTION 'ssi: employee A read a colleague sale'; END IF;
  SELECT count(*) INTO n FROM public.sale_items;
  IF n <> 1 THEN RAISE EXCEPTION 'ssi: employee A saw % items, expected 1', n; END IF;
  IF EXISTS (SELECT 1 FROM public.sale_items i WHERE i.sale_id = s.sale_a2) THEN
    RAISE EXCEPTION 'ssi: employee A read a colleague item'; END IF;

  -- tenant B is symmetrical: its owner must not see tenant A
  PERFORM set_config('request.jwt.claim.sub', s.ob::text, true);
  SELECT count(*) INTO n FROM public.sales;
  IF n <> 1 THEN RAISE EXCEPTION 'ssi: owner B saw % sales, expected 1', n; END IF;
  IF EXISTS (SELECT 1 FROM public.sales WHERE id = s.sale_a1) THEN
    RAISE EXCEPTION 'ssi: owner B read a foreign-tenant sale'; END IF;
END $$;
RESET ROLE;

-- ===========================================================================
-- 9  direct writes are refused (privilege, not just RLS)
-- ===========================================================================
SET LOCAL ROLE authenticated;
DO $$
DECLARE
  s ssi_state%row_type;
  denied boolean;
BEGIN
  SELECT * INTO s FROM ssi_state;
  PERFORM set_config('request.jwt.claim.sub', s.ea::text, true);

  denied := false;
  BEGIN
    INSERT INTO public.sales(store_id, user_id, total_amount, payment_method, status, cash_amount)
    VALUES (s.sa1, s.ea, 1, 'cash', 'completed', 1);
  EXCEPTION WHEN insufficient_privilege THEN denied := true;
  END;
  IF NOT denied THEN RAISE EXCEPTION 'ssi: direct sale insert was allowed'; END IF;

  denied := false;
  BEGIN
    INSERT INTO public.sale_items(sale_id, variant_id, quantity, original_price, final_price, unit_price, subtotal)
    VALUES (s.sale_a1, s.va, 1, 1000, 1000, 1000, 1000);
  EXCEPTION WHEN insufficient_privilege THEN denied := true;
  END;
  IF NOT denied THEN RAISE EXCEPTION 'ssi: direct sale_items insert was allowed'; END IF;

  denied := false;
  BEGIN
    UPDATE public.sales SET total_amount = 0 WHERE id = s.sale_a1;
  EXCEPTION WHEN insufficient_privilege THEN denied := true;
  END;
  IF NOT denied THEN RAISE EXCEPTION 'ssi: direct sale update was allowed'; END IF;

  denied := false;
  BEGIN
    DELETE FROM public.sale_items WHERE sale_id = s.sale_a1;
  EXCEPTION WHEN insufficient_privilege THEN denied := true;
  END;
  IF NOT denied THEN RAISE EXCEPTION 'ssi: direct sale_items delete was allowed'; END IF;

  denied := false;
  BEGIN
    TRUNCATE public.sales;
  EXCEPTION WHEN insufficient_privilege THEN denied := true;
  END;
  IF NOT denied THEN RAISE EXCEPTION 'ssi: direct sale truncate was allowed'; END IF;
END $$;
RESET ROLE;

-- ===========================================================================
-- 10-11 + 18  catalogue state: policies and privileges
-- ===========================================================================
DO $$
DECLARE
  n integer;
BEGIN
  IF current_user <> 'postgres' THEN RAISE EXCEPTION 'ssi: catalogue check must run as admin'; END IF;

  -- the four wide policies are gone
  SELECT count(*) INTO n FROM pg_policies
   WHERE schemaname = 'public' AND tablename IN ('sales', 'sale_items')
     AND policyname IN ('sales_select', 'sales_insert', 'sale_items_select', 'sale_items_insert');
  IF n <> 0 THEN RAISE EXCEPTION 'ssi: % wide policy(ies) still present', n; END IF;

  -- the four scoped policies exist
  SELECT count(*) INTO n FROM pg_policies
   WHERE schemaname = 'public' AND tablename = 'sales'
     AND policyname IN ('sales_tenant_read', 'sales_tenant_insert');
  IF n <> 2 THEN RAISE EXCEPTION 'ssi: sales policies missing (% found)', n; END IF;

  SELECT count(*) INTO n FROM pg_policies
   WHERE schemaname = 'public' AND tablename = 'sale_items'
     AND policyname IN ('sale_items_tenant_read', 'sale_items_tenant_insert');
  IF n <> 2 THEN RAISE EXCEPTION 'ssi: sale_items policies missing (% found)', n; END IF;

  -- nothing left that is not scoped to the staff identity
  SELECT count(*) INTO n FROM pg_policies
   WHERE schemaname = 'public' AND tablename IN ('sales', 'sale_items')
     AND coalesce(qual, '') NOT LIKE '%current_staff%'
     AND coalesce(with_check, '') NOT LIKE '%current_staff%';
  IF n <> 0 THEN RAISE EXCEPTION 'ssi: % unscoped policy(ies) remain', n; END IF;

  -- no UPDATE / DELETE policy was introduced
  SELECT count(*) INTO n FROM pg_policies
   WHERE schemaname = 'public' AND tablename IN ('sales', 'sale_items') AND cmd IN ('UPDATE', 'DELETE', 'ALL');
  IF n <> 0 THEN RAISE EXCEPTION 'ssi: % update/delete policy(ies) exist', n; END IF;

  -- privileges
  IF has_table_privilege('authenticated', 'public.sales', 'INSERT')      THEN RAISE EXCEPTION 'ssi: INSERT still granted on sales'; END IF;
  IF has_table_privilege('authenticated', 'public.sales', 'UPDATE')      THEN RAISE EXCEPTION 'ssi: UPDATE still granted on sales'; END IF;
  IF has_table_privilege('authenticated', 'public.sales', 'DELETE')      THEN RAISE EXCEPTION 'ssi: DELETE still granted on sales'; END IF;
  IF has_table_privilege('authenticated', 'public.sales', 'TRUNCATE')    THEN RAISE EXCEPTION 'ssi: TRUNCATE still granted on sales'; END IF;
  IF has_table_privilege('authenticated', 'public.sales', 'REFERENCES')  THEN RAISE EXCEPTION 'ssi: REFERENCES still granted on sales'; END IF;
  IF has_table_privilege('authenticated', 'public.sales', 'TRIGGER')     THEN RAISE EXCEPTION 'ssi: TRIGGER still granted on sales'; END IF;
  IF has_table_privilege('authenticated', 'public.sale_items', 'INSERT')     THEN RAISE EXCEPTION 'ssi: INSERT still granted on sale_items'; END IF;
  IF has_table_privilege('authenticated', 'public.sale_items', 'UPDATE')     THEN RAISE EXCEPTION 'ssi: UPDATE still granted on sale_items'; END IF;
  IF has_table_privilege('authenticated', 'public.sale_items', 'DELETE')     THEN RAISE EXCEPTION 'ssi: DELETE still granted on sale_items'; END IF;
  IF has_table_privilege('authenticated', 'public.sale_items', 'TRUNCATE')   THEN RAISE EXCEPTION 'ssi: TRUNCATE still granted on sale_items'; END IF;
  IF has_table_privilege('authenticated', 'public.sale_items', 'REFERENCES') THEN RAISE EXCEPTION 'ssi: REFERENCES still granted on sale_items'; END IF;
  IF has_table_privilege('authenticated', 'public.sale_items', 'TRIGGER')    THEN RAISE EXCEPTION 'ssi: TRIGGER still granted on sale_items'; END IF;
  IF NOT has_table_privilege('authenticated', 'public.sales', 'SELECT')      THEN RAISE EXCEPTION 'ssi: SELECT lost on sales'; END IF;
  IF NOT has_table_privilege('authenticated', 'public.sale_items', 'SELECT') THEN RAISE EXCEPTION 'ssi: SELECT lost on sale_items'; END IF;

  -- anon gets nothing at all
  IF has_table_privilege('anon', 'public.sales', 'SELECT')      THEN RAISE EXCEPTION 'ssi: anon can read sales'; END IF;
  IF has_table_privilege('anon', 'public.sale_items', 'SELECT') THEN RAISE EXCEPTION 'ssi: anon can read sale_items'; END IF;

  -- the server-side roles are untouched
  IF NOT has_table_privilege('service_role', 'public.sales', 'INSERT')      THEN RAISE EXCEPTION 'ssi: service_role lost INSERT on sales'; END IF;
  IF NOT has_table_privilege('service_role', 'public.sale_items', 'INSERT') THEN RAISE EXCEPTION 'ssi: service_role lost INSERT on sale_items'; END IF;

  -- RLS is still enabled on both
  SELECT count(*) INTO n FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace
   WHERE ns.nspname = 'public' AND c.relname IN ('sales', 'sale_items') AND c.relrowsecurity;
  IF n <> 2 THEN RAISE EXCEPTION 'ssi: RLS disabled on % table(s)', 2 - n; END IF;
END $$;

-- ===========================================================================
-- 12-16  the legitimate sale path still works, and still enforces the rules
-- ===========================================================================
SET LOCAL ROLE authenticated;
DO $$
DECLARE
  s ssi_state%row_type;
  before_qty integer;
  after_qty integer;
  new_sale uuid;
  denied boolean;
BEGIN
  SELECT * INTO s FROM ssi_state;
  PERFORM set_config('request.jwt.claim.sub', s.ea::text, true);

  SELECT quantity INTO before_qty FROM public.inventory WHERE store_id = s.sa1 AND variant_id = s.va;

  -- the app calls the staff wrapper, so exercise that one
  new_sale := public.engine_sync_sale_for_staff(
    s.sa1, s.ta, 'ssi-rpc-' || gen_random_uuid()::text,
    jsonb_build_array(jsonb_build_object('variant_id', s.va, 'quantity', 2,
                                         'original_price', 1000, 'final_price', 1000)),
    'cash', now(), s.ea, NULL);

  SELECT quantity INTO after_qty FROM public.inventory WHERE store_id = s.sa1 AND variant_id = s.va;
  IF after_qty <> before_qty - 2 THEN RAISE EXCEPTION 'ssi: stock not deducted atomically'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.sale_items WHERE sale_id = new_sale) THEN
    RAISE EXCEPTION 'ssi: sale items were not written'; END IF;

  -- 14 replaying the same local_id returns the same sale and deducts nothing
  IF public.engine_sync_sale_for_staff(
       s.sa1, s.ta, (SELECT local_id FROM public.sales WHERE id = new_sale),
       jsonb_build_array(jsonb_build_object('variant_id', s.va, 'quantity', 2,
                                            'original_price', 1000, 'final_price', 1000)),
       'cash', (SELECT created_at FROM public.sales WHERE id = new_sale), s.ea, NULL) <> new_sale THEN
    RAISE EXCEPTION 'ssi: replay did not return the same sale'; END IF;
  SELECT quantity INTO after_qty FROM public.inventory WHERE store_id = s.sa1 AND variant_id = s.va;
  IF after_qty <> before_qty - 2 THEN RAISE EXCEPTION 'ssi: replay deducted stock twice'; END IF;

  -- 16 a foreign store / foreign tenant is refused by the RPC itself
  denied := false;
  BEGIN
    PERFORM public.engine_sync_sale(
      s.sb1, s.tb, 'ssi-rpc-cross-' || gen_random_uuid()::text,
      jsonb_build_array(jsonb_build_object('variant_id', s.vb, 'quantity', 1,
                                           'original_price', 1000, 'final_price', 1000)),
      'cash', now(), NULL);
  EXCEPTION WHEN raise_exception THEN denied := true;
  END;
  IF NOT denied THEN RAISE EXCEPTION 'ssi: cross-tenant RPC was accepted'; END IF;
  IF EXISTS (SELECT 1 FROM public.sales WHERE local_id LIKE 'ssi-rpc-cross-%') THEN
    RAISE EXCEPTION 'ssi: cross-tenant RPC left a partial row'; END IF;

  -- 16b a foreign variant cannot be attached to a sale through the RPC either
  denied := false;
  BEGIN
    PERFORM public.engine_sync_sale(
      s.sa1, s.ta, 'ssi-rpc-foreign-variant-' || gen_random_uuid()::text,
      jsonb_build_array(jsonb_build_object('variant_id', s.vb, 'quantity', 1,
                                           'original_price', 1000, 'final_price', 1000)),
      'cash', now(), NULL);
  EXCEPTION WHEN raise_exception THEN denied := true;
  END;
  IF NOT denied THEN RAISE EXCEPTION 'ssi: foreign variant was accepted by the RPC'; END IF;

  -- 16c impersonation: the staff wrapper refuses a p_staff that is not the caller
  denied := false;
  BEGIN
    PERFORM public.engine_sync_sale_for_staff(
      s.sa1, s.ta, 'ssi-rpc-spoof-' || gen_random_uuid()::text,
      jsonb_build_array(jsonb_build_object('variant_id', s.va, 'quantity', 1,
                                           'original_price', 1000, 'final_price', 1000)),
      'cash', now(), s.ma, NULL);
  EXCEPTION WHEN raise_exception THEN denied := true;
  END;
  IF NOT denied THEN RAISE EXCEPTION 'ssi: staff wrapper accepted a foreign p_staff'; END IF;
  IF EXISTS (SELECT 1 FROM public.sales WHERE local_id LIKE 'ssi-rpc-spoof-%') THEN
    RAISE EXCEPTION 'ssi: spoofed sale left a row'; END IF;
END $$;
RESET ROLE;

-- 13 reserve stock as admin: the employee role cannot write inventory, and the
-- reservation itself is what the RPC must refuse to sell.
DO $$
DECLARE s ssi_state%row_type;
BEGIN
  SELECT * INTO s FROM ssi_state;
  UPDATE public.inventory SET reserved_qty = quantity - 1 WHERE store_id = s.sa1 AND variant_id = s.va;
END $$;

SET LOCAL ROLE authenticated;
DO $$
DECLARE
  s ssi_state%row_type;
  denied boolean;
BEGIN
  SELECT * INTO s FROM ssi_state;
  PERFORM set_config('request.jwt.claim.sub', s.ea::text, true);

  denied := false;
  BEGIN
    PERFORM public.engine_sync_sale_for_staff(
      s.sa1, s.ta, 'ssi-rpc-reserved-' || gen_random_uuid()::text,
      jsonb_build_array(jsonb_build_object('variant_id', s.va, 'quantity', 2,
                                           'original_price', 1000, 'final_price', 1000)),
      'cash', now(), s.ea, NULL);
  EXCEPTION WHEN raise_exception THEN denied := true;
  END;
  IF NOT denied THEN RAISE EXCEPTION 'ssi: reserved stock was sold'; END IF;

  -- 15 a refused sale leaves nothing behind
  IF EXISTS (SELECT 1 FROM public.sales WHERE local_id LIKE 'ssi-rpc-reserved-%') THEN
    RAISE EXCEPTION 'ssi: refused sale left a partial row'; END IF;
  IF EXISTS (SELECT 1 FROM public.sale_items i JOIN public.sales x ON x.id = i.sale_id
              WHERE x.local_id LIKE 'ssi-rpc-reserved-%') THEN
    RAISE EXCEPTION 'ssi: refused sale left a partial item'; END IF;
END $$;
RESET ROLE;

-- ===========================================================================
-- 17  a deactivated staff member loses access
-- ===========================================================================
-- Deactivate as admin: authenticated has only SELECT on users.
DO $$
DECLARE s ssi_state%row_type;
BEGIN
  SELECT * INTO s FROM ssi_state;
  UPDATE public.users SET is_active = false WHERE id = s.ea;
END $$;

SET LOCAL ROLE authenticated;
DO $$
DECLARE
  s ssi_state%row_type;
  n integer;
BEGIN
  SELECT * INTO s FROM ssi_state;
  PERFORM set_config('request.jwt.claim.sub', s.ea::text, true);

  SELECT count(*) INTO n FROM public.sales;
  IF n <> 0 THEN RAISE EXCEPTION 'ssi: deactivated staff still read % sale(s)', n; END IF;
  SELECT count(*) INTO n FROM public.sale_items;
  IF n <> 0 THEN RAISE EXCEPTION 'ssi: deactivated staff still read % item(s)', n; END IF;

  -- the RPC refuses them too
  IF public.current_staff_id() IS NOT NULL THEN
    RAISE EXCEPTION 'ssi: current_staff_id() still resolves for a deactivated staff member'; END IF;
END $$;
RESET ROLE;

-- ------------------------------------------------------------------ tidy up
UPDATE public.users SET is_active = true WHERE id IN (SELECT ea FROM ssi_state);

ROLLBACK;

-- ============================================================================
-- 20  re-running the migration
-- ----------------------------------------------------------------------------
-- Not part of this file (it must run against a database, not a transaction):
--   apply 202611170001_sales_sale_items_rls.sql twice, then re-run the checks
--   above. The second run must leave exactly four policies on the two tables
--   and must not re-grant any of the six privileges.
-- ============================================================================
