-- Security hardening: every public table gets RLS, and the public API keeps
-- working exclusively through the SECURITY DEFINER RPCs.
--
-- Why a loop instead of a list: the schema grew organically (nine tables were
-- found without RLS), so a hard-coded list would go stale the day someone adds
-- a table. This walks pg_class, enables RLS everywhere, strips every privilege
-- from `anon`, and writes a policy only where the table has a shape it
-- understands:
--
--   tenant_id                     -> tenant_id = current_tenant_id()
--   store_id                      -> the store belongs to the caller's tenant
--   tenant_id via a parent row    -> sale_items, order_items, product_variants…
--   existing policies             -> left alone (they were written per feature)
--   anything else                 -> RLS on, no policy: denied by default, and
--                                    the migration names the table in a NOTICE
--
-- current_tenant_id() is SECURITY DEFINER on purpose: without it the policy on
-- public.users would query public.users and recurse.
--
-- Apply after 202611120010. Idempotent: policies are only created when the
-- table has none, and re-running the loop changes nothing.

-- ------------------------------------------------------ caller's tenant
CREATE OR REPLACE FUNCTION public.current_tenant_id()
RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT tenant_id FROM public.users WHERE auth_id = auth.uid() LIMIT 1;
$$;

REVOKE ALL ON FUNCTION public.current_tenant_id() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.current_tenant_id() TO authenticated;

COMMENT ON FUNCTION public.current_tenant_id() IS
  'Tenant of the signed-in staff member. Used by every RLS policy.';

-- --------------------------------------------------- anon loses the tables
-- The storefront is anonymous, but it only ever calls the four public RPCs,
-- which run as their definer and bypass RLS. No table should be reachable.
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM anon;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM anon;
-- …and tables created later must not inherit a grant either.
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM anon;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM anon;

-- ------------------------------------------------------------- the sweep
DO $hardening$
DECLARE
  tbl record;
  col text;
  parent text;
  has_tenant boolean;
  has_store boolean;
  parents text[][] := ARRAY[
    ['sale_id', 'sales'],
    ['order_id', 'orders'],
    ['product_id', 'products'],
    ['variant_id', 'product_variants'],
    ['customer_id', 'customers'],
    ['credit_id', 'credits'],
    ['shift_id', 'shifts'],
    ['purchase_id', 'purchases'],
    ['supplier_id', 'suppliers'],
    ['payment_id', 'credit_payments'],
    ['user_id', 'users']
  ];
  idx integer;
  expr text;
  existing integer;
  total integer := 0;
  policied integer := 0;
  locked text[] := '{}';
BEGIN
  FOR tbl IN
    SELECT c.relname AS name
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relkind IN ('r', 'p')          -- ordinary and partitioned tables
     ORDER BY c.relname
  LOOP
    total := total + 1;

    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', tbl.name);
    EXECUTE format('REVOKE ALL ON TABLE public.%I FROM anon', tbl.name);

    -- A policy written for a specific feature is more precise than the generic
    -- one below, and re-creating over it would widen access. Leave it alone.
    SELECT count(*) INTO existing
      FROM pg_policies WHERE schemaname = 'public' AND tablename = tbl.name;
    CONTINUE WHEN existing > 0;

    SELECT EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_schema = 'public' AND table_name = tbl.name
                      AND column_name = 'tenant_id'),
           EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_schema = 'public' AND table_name = tbl.name
                      AND column_name = 'store_id')
      INTO has_tenant, has_store;

    IF tbl.name = 'tenants' THEN
      -- The tenant registry itself: a staff member sees their own row only.
      expr := format('id = public.current_tenant_id()');
      EXECUTE format('CREATE POLICY %I ON public.%I FOR ALL TO authenticated USING (%s) WITH CHECK (%s)',
                     'tenant_isolation', tbl.name, expr, expr);
      policied := policied + 1;

    ELSIF has_tenant THEN
      expr := 'tenant_id = public.current_tenant_id()';
      EXECUTE format('CREATE POLICY %I ON public.%I FOR ALL TO authenticated USING (%s) WITH CHECK (%s)',
                     'tenant_isolation', tbl.name, expr, expr);
      policied := policied + 1;

    ELSIF has_store THEN
      expr := format('EXISTS (SELECT 1 FROM public.stores s WHERE s.id = %I.store_id '
                     'AND s.tenant_id = public.current_tenant_id())', tbl.name);
      EXECUTE format('CREATE POLICY %I ON public.%I FOR ALL TO authenticated USING (%s) WITH CHECK (%s)',
                     'store_isolation', tbl.name, expr, expr);
      policied := policied + 1;

    ELSE
      -- No scope of its own: inherit the parent row's tenant (sale_items via
      -- sales, order_items via orders, product_variants via products…).
      expr := NULL;
      FOR idx IN 1 .. array_length(parents, 1) LOOP
        col := parents[idx][1];
        parent := parents[idx][2];
        CONTINUE WHEN NOT EXISTS (
          SELECT 1 FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = tbl.name AND column_name = col);
        CONTINUE WHEN NOT EXISTS (
          SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
           WHERE n.nspname = 'public' AND c.relname = parent AND c.relkind IN ('r', 'p'));

        IF EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_schema = 'public' AND table_name = parent AND column_name = 'tenant_id') THEN
          expr := format('EXISTS (SELECT 1 FROM public.%I p WHERE p.id = %I.%I '
                         'AND p.tenant_id = public.current_tenant_id())', parent, tbl.name, col);
        ELSIF EXISTS (SELECT 1 FROM information_schema.columns
                       WHERE table_schema = 'public' AND table_name = parent AND column_name = 'store_id') THEN
          expr := format('EXISTS (SELECT 1 FROM public.%I p JOIN public.stores s ON s.id = p.store_id '
                         'WHERE p.id = %I.%I AND s.tenant_id = public.current_tenant_id())',
                         parent, tbl.name, col);
        ELSE
          -- The parent has its own policy; being able to see it is enough.
          expr := format('EXISTS (SELECT 1 FROM public.%I p WHERE p.id = %I.%I)',
                         parent, tbl.name, col);
        END IF;
        EXIT;                                  -- first matching parent wins
      END LOOP;

      IF expr IS NULL THEN
        locked := locked || tbl.name::text;    -- RLS on, no policy: denied
      ELSE
        EXECUTE format('CREATE POLICY %I ON public.%I FOR ALL TO authenticated USING (%s) WITH CHECK (%s)',
                       'parent_isolation', tbl.name, expr, expr);
        policied := policied + 1;
      END IF;
    END IF;
  END LOOP;

  RAISE NOTICE 'RLS hardening: % tables scanned, % policies created.', total, policied;
  IF array_length(locked, 1) > 0 THEN
    RAISE NOTICE 'RLS hardening: no scope column, access denied until a policy is written: %',
      array_to_string(locked, ', ');
  END IF;
END $hardening$;

-- ------------------------------------------------------------- the proof
-- A one-row view the dashboard can query to show an administrator that nothing
-- is left open: any table with rls_enabled = false is a real hole.
CREATE OR REPLACE VIEW public.security_audit AS
  SELECT c.relname AS table_name,
         c.relrowsecurity AS rls_enabled,
         (SELECT count(*) FROM pg_policies p
           WHERE p.schemaname = 'public' AND p.tablename = c.relname) AS policy_count,
         -- By oid, not by name: a name-based lookup would have to resolve every
         -- relation in the catalogue and error on rows it should have skipped.
         has_table_privilege('anon', c.oid, 'SELECT') AS anon_can_read
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public'
     AND c.relkind IN ('r', 'p')
   ORDER BY c.relname;

REVOKE ALL ON public.security_audit FROM PUBLIC, anon;
GRANT SELECT ON public.security_audit TO authenticated;
