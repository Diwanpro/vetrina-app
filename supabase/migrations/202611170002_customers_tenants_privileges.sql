-- ============================================================================
-- 202611170002 — customers / tenants isolation and the TRUNCATE privilege
--
-- Why
-- ----
-- customers: the live database carries one wide policy (`customers_select`,
-- FOR ALL, USING (true)) with no tenant predicate. Any signed-in user could
-- read and write every tenant's customers. The application only reads
-- customers directly (the customers screen and the POS picker); every write
-- already goes through SECURITY DEFINER RPCs (`engine_create_credit`,
-- `engine_merge_duplicates`, …) which run as the function owner and are not
-- affected by a revoke on `authenticated`.
--
-- tenants: the live `tenant_isolation` policy is FOR ALL with
-- USING/WITH CHECK (id = current_tenant_id()). That lets any signed-in user
-- UPDATE their own tenant row — including `is_active`, `subscription_plan`,
-- `subscription_end_date` and `branches_limit` — and self-activate a trial.
-- The application never reads or writes `tenants` directly; activation,
-- licence redemption and trial start all go through SECURITY DEFINER RPCs
-- (`engine_activate`, `engine_create_trial_tenant`).
--
-- TRUNCATE: RLS does not restrict TRUNCATE at all, so a table with RLS can
-- still be emptied by anyone holding the privilege. `authenticated` holds
-- TRUNCATE on the public tables by default. Nothing in the application or in
-- any SECURITY DEFINER function issues TRUNCATE (they run as the owner), so
-- the privilege is revoked across `public`. This is a targeted revoke of one
-- privilege, not a mass revoke: SELECT/INSERT/UPDATE/DELETE are untouched.
--
-- Idempotent: policies are dropped before they are created, and every REVOKE
-- is a no-op when the privilege is already absent.
-- ============================================================================

SET LOCAL lock_timeout = '3s';

-- ------------------------------------------------------------- customers
ALTER TABLE public.customers ENABLE ROW LEVEL SECURITY;

-- Drop every existing policy rather than only the known wide one: a fresh
-- database built from the repository never had `customers_select`, and a
-- policy added by a later feature must not silently widen the table either.
DO $customers_policies$
DECLARE p record;
BEGIN
  FOR p IN
    SELECT policyname FROM pg_policies
     WHERE schemaname = 'public' AND tablename = 'customers'
  LOOP
    EXECUTE format('DROP POLICY %I ON public.customers', p.policyname);
  END LOOP;
END $customers_policies$;

-- Read: the caller's active staff row decides the tenant. `current_staff()`
-- filters on `is_active`, so a deactivated user resolves to no row at all.
CREATE POLICY customers_tenant_read ON public.customers
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.current_staff() u
       WHERE u.tenant_id = customers.tenant_id
    )
  );

-- Writes are only legitimate through the SECURITY DEFINER RPCs.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON public.customers FROM authenticated;
GRANT SELECT ON public.customers TO authenticated;

-- --------------------------------------------------------------- tenants
ALTER TABLE public.tenants ENABLE ROW LEVEL SECURITY;

DO $tenants_policies$
DECLARE p record;
BEGIN
  FOR p IN
    SELECT policyname FROM pg_policies
     WHERE schemaname = 'public' AND tablename = 'tenants'
  LOOP
    EXECUTE format('DROP POLICY %I ON public.tenants', p.policyname);
  END LOOP;
END $tenants_policies$;

-- Read: the caller's own tenant row only. Writes are not exposed at all;
-- activation, licence redemption and trial start go through the RPCs.
CREATE POLICY tenant_isolation_read ON public.tenants
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.current_staff() u
       WHERE u.tenant_id = tenants.id
    )
  );

REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON public.tenants FROM authenticated;
GRANT SELECT ON public.tenants TO authenticated;

-- ------------------------------------------------------- TRUNCATE privilege
-- One privilege, every table. The application never issues TRUNCATE and the
-- SECURITY DEFINER functions run as the table owner, so this cannot break a
-- legitimate path while it closes the "RLS does not cover TRUNCATE" hole.
DO $truncate_privilege$
DECLARE t record;
BEGIN
  FOR t IN
    SELECT c.relname AS name
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
  LOOP
    EXECUTE format('REVOKE TRUNCATE ON public.%I FROM authenticated', t.name);
  END LOOP;
END $truncate_privilege$;

-- Tables created later must not silently regain the privilege. Default
-- privileges are per creating role, so this covers tables created by the role
-- that runs the migration (postgres); the sweep above covers what exists now.
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE TRUNCATE ON TABLES FROM authenticated;

NOTIFY pgrst, 'reload schema';
