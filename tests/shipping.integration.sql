-- Manual verification of the P1/P3 shipping RLS on a LIVE Supabase project.
-- Run as an SQL editor/admin AFTER applying 202611120015 + 202611120016. These
-- statements are documentation-style checks (the node test suite cannot reach
-- Postgres here).
--
-- Goal: an authenticated staff member can read their tenant's shipments, but
-- can never SELECT the merchant's encrypted API keys, and anon sees nothing.

-- 1) Every table has RLS on and no anon privilege.
SELECT table_name, rls_enabled, policy_count, anon_can_read
  FROM public.security_audit
 WHERE table_name LIKE 'shipping%' OR table_name IN ('shipments','shipment_events')
 ORDER BY table_name;
-- Expect: rls_enabled = true, anon_can_read = false for all rows.
-- shipping_connections must have policy_count = 0.

-- 2) The generic hardening sweep did not silently open the secret table.
SELECT policyname, cmd, roles
  FROM pg_policies
 WHERE schemaname = 'public' AND tablename = 'shipping_connections';
-- Expect: 0 rows.

-- 3) Direct read of secrets as an authenticated user must be denied.
--    (Paste into the SQL editor with an authenticated JWT / or use the REST
--     API with an anon key + user bearer token.)
--    SELECT * FROM public.shipping_connections;  -> permission denied / 0 rows

-- 4) The masked RPC returns the hint, never the ciphertext.
--    As an owner/manager of the branch:
SELECT jsonb_pretty(public.engine_list_shipping_connections('<STORE_UUID>')) AS masked;
-- Expect keys: provider_code, environment, mode, enabled, credentials_hint…
-- Expect NO key named credentials_ciphertext.

-- 5) Cross-tenant isolation: replace <OTHER_TENANT_STORE_UUID> with a store
--    that belongs to a different tenant. The RPC must raise an exception.
--    SELECT public.engine_list_shipping_connections('<OTHER_TENANT_STORE_UUID>');

-- 6) public.orders is untouched: no new column, no changed constraint.
SELECT column_name, data_type
  FROM information_schema.columns
 WHERE table_schema = 'public' AND table_name = 'orders'
 ORDER BY ordinal_position;
-- Compare with the DDL in 202611120005_ecommerce_phase_a.sql: identical.

-- 7) One active shipment per order per courier.
--    Attempting a second INSERT with the same (order_id, provider_code) and a
--    non-cancelled status must fail on shipments_active_per_order.

-- 8) Idempotency: two webhook events with the same (provider_code, event_key)
--    must conflict on shipment_events_key.

-- 9) P3 snapshot RPC exists, is a definer function, and is not callable by anon.
SELECT p.proname, pg_get_function_result(p.oid) AS result, p.prosecdef, p.provolatile
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public' AND p.proname = 'engine_order_shipping_snapshot';
-- Expect 1 row: result = jsonb, prosecdef = true, provolatile = s.
SELECT has_function_privilege('anon', 'public.engine_order_shipping_snapshot(uuid)', 'EXECUTE') AS anon_can_execute;
-- Expect false.

-- 10) The P3/P4 migrations added no column/constraint/trigger/policy to orders.
SELECT count(*) AS orders_columns
  FROM information_schema.columns
 WHERE table_schema = 'public' AND table_name = 'orders';
-- Expect 27, exactly as before P1/P2/P3/P4.

-- 11) P4 export-candidates RPC exists, is read-only definer, and anon cannot call it.
SELECT p.proname, pg_get_function_result(p.oid) AS result, p.prosecdef, p.provolatile
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public' AND p.proname = 'engine_shipping_export_candidates';
-- Expect 1 row: result = jsonb, prosecdef = true, provolatile = s.
SELECT has_function_privilege('anon', 'public.engine_shipping_export_candidates(uuid, text)', 'EXECUTE') AS anon_can_execute;
-- Expect false.

-- 12) P4 duplicate-export guards are present.
SELECT indexname, indexdef
  FROM pg_indexes
 WHERE schemaname = 'public'
   AND indexname IN ('shipping_export_items_order_once','shipments_bulk_export_once')
 ORDER BY indexname;
-- Expect 2 rows; the second is a partial unique index on bulk/exported shipments.

-- 13) An order with an active shipment or a previous export item must NOT be
--     returned by engine_shipping_export_candidates('<STORE_UUID>', 'yalidine').
--     Only confirmed/preparing delivery orders are eligible.

-- 14) No shipping gateway write ever targets public.orders. Inspect triggers,
--     policies, and column count again after applying 202611120017: unchanged.
