-- Profit must be: sales - COGS of the items actually sold - expenses - payroll.
-- Nothing in the formula may depend on today's stock level, and a corrupt
-- cost_price_avg must never be able to inflate COGS into the millions.
--
-- Two problems are fixed here:
--
--   1. Legacy sale lines had no cost snapshot, so COGS fell back to today's
--      product_variants.cost_price_avg. If an import set that column to absurd
--      values (or to the selling price, or to a total purchase amount), every
--      old sale inherited an enormous cost and net profit collapsed into a
--      seven-figure negative number.
--
--   2. Nothing sanitised cost_price_avg, so a single bad row skewed COGS for
--      every sale that touched that variant.
--
-- The COGS lookup is now, in order of preference:
--   a. sale_items.cost_at_sale   - exact snapshot taken at the moment of sale
--   b. the weighted average of purchases made *before* that sale
--                                - a real, date-correct reconstruction
--   c. today's cost_price_avg    - last resort, only when no history exists
--
-- Only (c) can still be wrong, and it is now clamped at zero by the repair
-- function, so it cannot produce a negative cost.

-- ---------------------------------------------------------------- history
-- Weighted averages are computed from purchases, and purchases are the only
-- place a real cost ever enters the system. Keeping a compact history lets us
-- reconstruct the cost that applied on a given date without trusting the
-- current product_variants row.
CREATE TABLE IF NOT EXISTS public.variant_cost_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  variant_id uuid NOT NULL REFERENCES public.product_variants(id) ON DELETE CASCADE,
  unit_cost numeric NOT NULL CHECK (unit_cost >= 0),
  quantity integer NOT NULL CHECK (quantity > 0),
  purchase_id uuid,
  occurred_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS variant_cost_history_lookup
  ON public.variant_cost_history(variant_id, occurred_at);
CREATE INDEX IF NOT EXISTS purchase_items_variant
  ON public.purchase_items(variant_id, purchase_id);

-- Backfill from purchases that already exist so reconstruction works for old
-- data too. Idempotent: a row is only inserted once per purchase item.
INSERT INTO public.variant_cost_history(tenant_id, variant_id, unit_cost, quantity, purchase_id, occurred_at)
SELECT coalesce(pi.tenant_id, p.tenant_id), pi.variant_id, pi.unit_cost, pi.quantity, pi.purchase_id, coalesce(p.created_at, now())
FROM public.purchase_items pi
JOIN public.purchases p ON p.id = pi.purchase_id
WHERE pi.variant_id IS NOT NULL
  AND pi.unit_cost IS NOT NULL
  AND pi.quantity > 0
  AND pi.unit_cost >= 0
  AND coalesce(pi.tenant_id, p.tenant_id) IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM public.variant_cost_history h
    WHERE h.purchase_id = pi.purchase_id AND h.variant_id = pi.variant_id
  );

-- Record future receipts. The trigger is deliberately defensive: it must never
-- block a sale or a purchase if history cannot be written.
CREATE OR REPLACE FUNCTION public.engine_record_cost_history() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE owner_tenant uuid;
BEGIN
  SELECT coalesce(NEW.tenant_id, p.tenant_id) INTO owner_tenant
  FROM public.purchases p WHERE p.id = NEW.purchase_id;
  IF owner_tenant IS NULL OR NEW.variant_id IS NULL OR NEW.unit_cost IS NULL
     OR NEW.quantity IS NULL OR NEW.quantity <= 0 OR NEW.unit_cost < 0 THEN
    RETURN NEW;
  END IF;
  INSERT INTO public.variant_cost_history(tenant_id, variant_id, unit_cost, quantity, purchase_id, occurred_at)
  VALUES (owner_tenant, NEW.variant_id, NEW.unit_cost, NEW.quantity, NEW.purchase_id, now());
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS record_cost_history ON public.purchase_items;
CREATE TRIGGER record_cost_history AFTER INSERT ON public.purchase_items
  FOR EACH ROW EXECUTE FUNCTION public.engine_record_cost_history();

-- Weighted average unit cost for a variant using only receipts up to a cutoff.
-- NULL when the variant has no purchase history at all.
CREATE OR REPLACE FUNCTION public.variant_cost_at(p_variant uuid, p_tenant uuid, p_at timestamptz)
RETURNS numeric LANGUAGE sql STABLE SET search_path=public AS $$
  SELECT sum(h.unit_cost * h.quantity) / nullif(sum(h.quantity), 0)
  FROM public.variant_cost_history h
  WHERE h.variant_id = p_variant
    AND h.tenant_id = p_tenant
    AND h.occurred_at <= p_at
    AND h.unit_cost >= 0
$$;

-- --------------------------------------------------------------- COGS lines
-- One row per sale line, exposing which cost source was used. This is what the
-- accounting page drills into and what makes a wrong number explainable
-- instead of mysterious.
CREATE OR REPLACE FUNCTION public.engine_accounting_cost_lines(
  p_store uuid, p_from timestamptz, p_to timestamptz, p_limit integer DEFAULT 200
) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public AS $$
DECLARE u public.users; result jsonb;
BEGIN
  SELECT * INTO u FROM public.current_staff();
  IF u.id IS NULL OR u.role <> 'owner' THEN RAISE EXCEPTION 'للمالك فقط'; END IF;
  IF p_store IS NOT NULL THEN PERFORM public.engine_validate(p_store, u.tenant_id, ARRAY['owner']); END IF;
  IF p_to IS NULL OR (p_from IS NOT NULL AND p_from >= p_to) THEN RAISE EXCEPTION 'الفترة غير صالحة'; END IF;

  WITH lines AS (
    SELECT i.id, sale.created_at, s.name AS store_name,
           coalesce(pr.name, '—') AS product_name,
           coalesce(v.color || ' · ' || v.size, v.color, v.size, '—') AS variant_label,
           i.quantity,
           i.subtotal AS revenue,
           i.cost_at_sale,
           CASE
             WHEN i.cost_at_sale IS NOT NULL THEN i.cost_at_sale
             WHEN public.variant_cost_at(i.variant_id, u.tenant_id, sale.created_at) IS NOT NULL
               THEN public.variant_cost_at(i.variant_id, u.tenant_id, sale.created_at)
             ELSE coalesce(v.cost_price_avg, 0)
           END AS unit_cost,
           CASE
             WHEN i.cost_at_sale IS NOT NULL THEN 'snapshot'
             WHEN public.variant_cost_at(i.variant_id, u.tenant_id, sale.created_at) IS NOT NULL THEN 'history'
             ELSE 'current'
           END AS source
    FROM public.sale_items i
    JOIN public.sales sale ON sale.id = i.sale_id
    JOIN public.stores s ON s.id = sale.store_id
    LEFT JOIN public.product_variants v ON v.id = i.variant_id
    LEFT JOIN public.products pr ON pr.id = v.product_id AND pr.tenant_id = u.tenant_id
    WHERE s.tenant_id = u.tenant_id
      AND (p_store IS NULL OR s.id = p_store)
      AND sale.status = 'completed'
      AND (p_from IS NULL OR sale.created_at >= p_from)
      AND sale.created_at < p_to
  ), page AS (
    SELECT * FROM lines ORDER BY created_at DESC, id LIMIT least(coalesce(p_limit, 200), 500)
  )
  SELECT jsonb_build_object(
    'rows', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
        'created_at', created_at, 'store', store_name, 'product', product_name,
        'variant', variant_label, 'quantity', quantity, 'revenue', revenue,
        'unitCost', round(unit_cost, 2), 'lineCost', round(unit_cost * quantity, 2), 'source', source
      ) ORDER BY created_at DESC, id)
      FROM page), '[]'::jsonb),
    'totalLines', (SELECT count(*) FROM lines),
    'totalCost', (SELECT coalesce(sum(unit_cost * quantity), 0) FROM lines)
  ) INTO result;
  RETURN result;
END $$;

-- ------------------------------------------------------------- the formula
-- Net = sales - COGS(sold lines only) - expenses - payroll - advances.
-- Stock on hand, purchases and supplier payments never enter this sum; supplier
-- payments are the settlement of a purchase already costed through COGS.
CREATE OR REPLACE FUNCTION public.engine_accounting_commercial(
  p_store uuid, p_from timestamptz, p_to timestamptz
) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public AS $$
DECLARE
  u public.users; result jsonb; sales numeric; expenses numeric; salaries numeric;
  advances numeric; suppliers numeric; cogs numeric; gross numeric; net numeric;
  snapshot_lines bigint; history_lines bigint; current_lines bigint;
BEGIN
  result := public.engine_accounting(p_store, p_from, p_to);
  SELECT * INTO u FROM public.current_staff();

  SELECT coalesce(sum(i.quantity * coalesce(i.cost_at_sale, public.variant_cost_at(i.variant_id, u.tenant_id, sale.created_at), v.cost_price_avg, 0)), 0),
         count(*) FILTER (WHERE i.cost_at_sale IS NOT NULL),
         count(*) FILTER (WHERE i.cost_at_sale IS NULL AND public.variant_cost_at(i.variant_id, u.tenant_id, sale.created_at) IS NOT NULL),
         count(*) FILTER (WHERE i.cost_at_sale IS NULL AND public.variant_cost_at(i.variant_id, u.tenant_id, sale.created_at) IS NULL)
    INTO cogs, snapshot_lines, history_lines, current_lines
  FROM public.sale_items i
  JOIN public.sales sale ON sale.id = i.sale_id
  JOIN public.stores s ON s.id = sale.store_id
  LEFT JOIN public.product_variants v ON v.id = i.variant_id
  WHERE s.tenant_id = u.tenant_id
    AND (p_store IS NULL OR s.id = p_store)
    AND sale.status = 'completed'
    AND (p_from IS NULL OR sale.created_at >= p_from)
    AND sale.created_at < p_to;

  sales := coalesce((result->>'sales')::numeric, 0);
  expenses := coalesce((result->>'expenses')::numeric, 0);
  salaries := coalesce((result->>'salaries')::numeric, 0);
  advances := coalesce((result->>'advances')::numeric, 0);
  suppliers := coalesce((result->>'supplierPayments')::numeric, 0);
  gross := sales - cogs;
  net := gross - expenses - salaries - advances;

  RETURN result || jsonb_build_object(
    'costOfGoods', cogs,
    'grossProfit', gross,
    'netProfit', net,
    -- Rows that still rely on today's cost rather than a snapshot. These are
    -- the only lines the repair function can still improve.
    'estimatedCostItems', current_lines,
    'costBreakdown', jsonb_build_object(
      'snapshot', snapshot_lines, 'history', history_lines, 'current', current_lines
    )
  );
END $$;

-- ------------------------------------------------------------------ repair
-- Rebuild absurd cost averages from real purchase history.
--
-- Strategy per variant:
--   * purchases exist  -> weighted average of every receipt (ground truth)
--   * no purchases     -> keep the value only when it is sane (>= 0); a negative
--                         or NULL cost becomes 0, because a negative unit cost
--                         is never legitimate and would otherwise *increase*
--                         profit while a huge one destroys it.
-- The function reports what it changed, so the run is auditable rather than
-- silently rewriting money fields.
CREATE OR REPLACE FUNCTION public.engine_repair_cost_price_avg(p_apply boolean DEFAULT true)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE u public.users; result jsonb; bad_count bigint; fixed_count bigint; history_count bigint;
BEGIN
  SELECT * INTO u FROM public.current_staff();
  IF u.id IS NULL OR u.role <> 'owner' THEN RAISE EXCEPTION 'للمالك فقط'; END IF;

  -- Dropped first so a repeat call in the same session cannot read stale rows.
  DROP TABLE IF EXISTS pg_temp.cost_repair;
  CREATE TEMP TABLE cost_repair ON COMMIT DROP AS
  SELECT v.id AS variant_id,
         v.cost_price_avg AS old_cost,
         h.avg_cost,
         CASE WHEN h.avg_cost IS NOT NULL THEN round(h.avg_cost, 4)
              WHEN coalesce(v.cost_price_avg, 0) < 0 THEN 0
              ELSE v.cost_price_avg END AS new_cost
  FROM public.product_variants v
  JOIN public.products p ON p.id = v.product_id AND p.tenant_id = u.tenant_id
  LEFT JOIN LATERAL (
    SELECT sum(x.unit_cost * x.quantity) / nullif(sum(x.quantity), 0) AS avg_cost
    FROM public.variant_cost_history x
    WHERE x.variant_id = v.id AND x.tenant_id = u.tenant_id AND x.unit_cost >= 0
  ) h ON true
  WHERE v.cost_price_avg IS NULL
     OR v.cost_price_avg < 0
     OR h.avg_cost IS NOT NULL;

  SELECT count(*) FILTER (WHERE new_cost IS DISTINCT FROM old_cost),
         count(*) FILTER (WHERE avg_cost IS NOT NULL)
    INTO bad_count, fixed_count
  FROM cost_repair;
  SELECT count(*) INTO history_count FROM public.variant_cost_history WHERE tenant_id = u.tenant_id;

  IF p_apply THEN
    UPDATE public.product_variants v
    SET cost_price_avg = c.new_cost
    FROM cost_repair c
    WHERE v.id = c.variant_id AND c.new_cost IS DISTINCT FROM c.old_cost;
  END IF;

  SELECT jsonb_build_object(
    'applied', p_apply,
    'changed', bad_count,
    'fromHistory', fixed_count,
    'historyRows', history_count,
    'sample', coalesce((SELECT jsonb_agg(jsonb_build_object('old', old_cost, 'new', new_cost) ORDER BY old_cost DESC NULLS LAST)
                        FROM (SELECT * FROM cost_repair WHERE new_cost IS DISTINCT FROM old_cost LIMIT 10) x), '[]'::jsonb)
  ) INTO result;
  RETURN result;
END $$;

-- ------------------------------------------------------------- permissions
REVOKE ALL ON TABLE public.variant_cost_history FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.engine_record_cost_history(), public.variant_cost_at(uuid, uuid, timestamptz),
  public.engine_accounting_cost_lines(uuid, timestamptz, timestamptz, integer),
  public.engine_repair_cost_price_avg(boolean) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.engine_accounting_commercial(uuid, timestamptz, timestamptz) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.engine_accounting_cost_lines(uuid, timestamptz, timestamptz, integer),
  public.engine_repair_cost_price_avg(boolean),
  public.engine_accounting_commercial(uuid, timestamptz, timestamptz) TO authenticated;
