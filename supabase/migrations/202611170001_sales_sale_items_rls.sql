-- ============================================================================
-- 202611170001 — sales / sale_items: tenant and branch isolation
--
-- Why
-- ----
-- Neither table carries a tenant_id. The four policies that exist in the live
-- database — sales_select, sales_insert, sale_items_select, sale_items_insert —
-- test the role only, never the tenant:
--
--   sales_select       current_role() IN ('owner','manager') OR user_id = current_staff_id()
--   sales_insert       user_id = current_staff_id()
--   sale_items_select  EXISTS (sales s WHERE s.id = sale_id AND (role owner/manager OR s.user_id = current_staff_id()))
--   sale_items_insert  same predicate
--
-- So any owner or manager could read every tenant's rows, and any signed-in user
-- could insert a sale into any store. Those four policies are NOT in this
-- repository: a fresh database built from migrations never had them. The live
-- database keeps them because 202611120011_security_hardening.sql skips a table
-- that already has a policy (CONTINUE WHEN existing > 0).
--
-- What
-- ----
--   1. drop the four wide policies (PERMISSIVE policies are combined with OR,
--      so a new narrower policy cannot take effect while an old wide one stays);
--   2. create SELECT / INSERT policies that derive the tenant from
--      sales.store_id -> stores.tenant_id and, for sale_items, from the parent
--      sale plus product_variants -> products;
--   3. revoke the direct write privileges authenticated has no legitimate use
--      for. Every legitimate write already goes through SECURITY DEFINER
--      functions owned by postgres (engine_sync_sale, engine_sync_sale_for_staff,
--      update_order_status) or through triggers (engine_snapshot_cost,
--      engine_sale_attendance), so the revoke does not touch the sale path.
--
-- No UPDATE or DELETE policy is created: no application path updates or deletes
-- a sale or a sale item directly, and RLS denies what no policy covers.
--
-- Idempotent
-- ----------
-- Every DROP is IF EXISTS and every CREATE follows a DROP of the same name, so
-- re-running the file converges to the same state.
--
-- Rollback
-- --------
-- This migration is deliberately NOT reversible to the previous state: the
-- previous state is the vulnerability. To switch the hardening off temporarily,
-- drop the four new policies only — RLS stays enabled and, with no permissive
-- policy left, access is denied by default. Restoring the old wide policies (or
-- re-granting write privileges) reopens a critical hole and must never be
-- automated. The old expressions are recorded above for audit, not for reuse.
-- ============================================================================

SET LOCAL lock_timeout = '3s';

-- ------------------------------------------------- the four wide old policies
DROP POLICY IF EXISTS sales_select      ON public.sales;
DROP POLICY IF EXISTS sales_insert      ON public.sales;
DROP POLICY IF EXISTS sale_items_select ON public.sale_items;
DROP POLICY IF EXISTS sale_items_insert ON public.sale_items;

-- ------------------------------------------------------------------- sales
DROP POLICY IF EXISTS sales_tenant_read   ON public.sales;
DROP POLICY IF EXISTS sales_tenant_insert ON public.sales;

-- Read: the store must belong to the caller's tenant, and the caller's role
-- decides how much of that tenant is visible. current_staff() filters on
-- is_active, so a deactivated or unknown caller resolves to no row at all.
CREATE POLICY sales_tenant_read ON public.sales
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1
        FROM public.stores s
        JOIN public.current_staff() u ON u.tenant_id = s.tenant_id
         WHERE s.id = sales.store_id
         AND ( u.role = 'owner'
            OR (u.role = 'manager' AND s.id = u.store_id)
            OR (u.role = 'employee' AND s.id = u.store_id) )
    )
  );

-- Insert: the row must belong to the caller, and the store must belong to the
-- caller's tenant and, for a non-owner, to the caller's assigned store.
CREATE POLICY sales_tenant_insert ON public.sales
  FOR INSERT TO authenticated
  WITH CHECK (
    sales.user_id = (SELECT u.id FROM public.current_staff() u)
    AND EXISTS (
      SELECT 1
        FROM public.stores s
        JOIN public.current_staff() u ON u.tenant_id = s.tenant_id
       WHERE s.id = sales.store_id
         AND ( u.role = 'owner' OR s.id = u.store_id )
    )
  );

-- -------------------------------------------------------------- sale_items
DROP POLICY IF EXISTS sale_items_tenant_read   ON public.sale_items;
DROP POLICY IF EXISTS sale_items_tenant_insert ON public.sale_items;

-- Read: the parent sale must be readable under exactly the sales rules. The
-- predicate is written out in full rather than relying on the parent's RLS, so
-- the two policies cannot silently disagree.
CREATE POLICY sale_items_tenant_read ON public.sale_items
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1
        FROM public.sales s
        JOIN public.stores st ON st.id = s.store_id
        JOIN public.current_staff() u ON u.tenant_id = st.tenant_id
       WHERE s.id = sale_items.sale_id
         AND ( u.role = 'owner'
            OR (u.role = 'manager' AND st.id = u.store_id)
            OR (u.role = 'employee' AND st.id = u.store_id) )
    )
  );

-- Insert: same scope as the parent sale, plus the variant's product must belong
-- to the same tenant as the sale's store.
CREATE POLICY sale_items_tenant_insert ON public.sale_items
  FOR INSERT TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1
        FROM public.sales s
        JOIN public.stores st ON st.id = s.store_id
        JOIN public.current_staff() u ON u.tenant_id = st.tenant_id
        JOIN public.product_variants v ON v.id = sale_items.variant_id
        JOIN public.products p ON p.id = v.product_id AND p.tenant_id = st.tenant_id
       WHERE s.id = sale_items.sale_id
         AND ( u.role = 'owner'
            OR (u.role = 'manager' AND st.id = u.store_id)
            OR (u.role = 'employee' AND s.user_id = u.id) )
    )
  );

-- ------------------------------------------------------------- privileges
-- Keep SELECT (the dashboard reads both tables directly); remove everything
-- the application has no legitimate direct use for. TRUNCATE is the important
-- one: RLS does not restrict TRUNCATE at all.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON public.sales      FROM authenticated;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON public.sale_items FROM authenticated;

GRANT SELECT ON public.sales      TO authenticated;
GRANT SELECT ON public.sale_items TO authenticated;

NOTIFY pgrst, 'reload schema';
