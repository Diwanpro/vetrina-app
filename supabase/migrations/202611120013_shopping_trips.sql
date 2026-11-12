-- ============================================================================
-- 202611120013 — Shopping trips
--
-- A purchase trip is one journey to a supplier: goods bought, plus the cost of
-- getting there and back. The trip's expenses (transport, food, parking) are a
-- *cost of the goods*, not a shop expense:
--
--   unit_true_cost = unit_cost + floor(trip_expenses / total_units)
--
-- They are spread over every unit bought on the trip and folded into
-- `product_variants.cost_price_avg`, so the margin on those items is honest
-- from the moment they are stocked.
--
-- WHY THEY ARE NOT ROWS IN `expenses`:
--   `expenses` is a cash-drawer ledger. The close-shift reconciliation
--   (engine_close_shift) subtracts today's expenses from the expected drawer
--   total. A 4000 DA minibus fare never left the shop's till, so writing it
--   there would make the drawer look 4000 DA short at closing. Trip costs live
--   in `shopping_trips` / `shopping_trip_expenses`, which nothing reconciles.
--
-- Two halves:
--   * the history tables (RLS enabled, no write policy — writes go through the
--     RPC, the same shape as purchases/suppliers);
--   * engine_save_trip(), which writes the purchase, the stock, the true cost
--     and the history in one transaction.
-- ============================================================================

-- ---------------------------------------------------------------- the trip
CREATE TABLE IF NOT EXISTS public.shopping_trips (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  store_id      uuid NOT NULL REFERENCES public.stores(id) ON DELETE CASCADE,
  supplier_id   uuid REFERENCES public.suppliers(id) ON DELETE SET NULL,
  supplier_name text,
  trip_date     date NOT NULL DEFAULT current_date,
  notes         text,
  -- Money the goods cost, and the money the journey cost. Kept apart so the
  -- spread can be re-read later without re-deriving it from the items.
  goods_cost    integer NOT NULL DEFAULT 0 CHECK (goods_cost >= 0),
  trip_expenses integer NOT NULL DEFAULT 0 CHECK (trip_expenses >= 0),
  -- floor(trip_expenses / units) actually added to each unit this trip touched.
  cost_per_unit integer NOT NULL DEFAULT 0 CHECK (cost_per_unit >= 0),
  total_units   integer NOT NULL DEFAULT 0 CHECK (total_units >= 0),
  purchase_id   uuid REFERENCES public.purchases(id) ON DELETE SET NULL,
  created_by    uuid REFERENCES public.users(id) ON DELETE SET NULL,
  request_id    uuid NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS shopping_trips_request_id ON public.shopping_trips(request_id);
CREATE INDEX IF NOT EXISTS shopping_trips_store_date ON public.shopping_trips(store_id, trip_date DESC);

-- ------------------------------------------------------- the trip's expenses
CREATE TABLE IF NOT EXISTS public.shopping_trip_expenses (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trip_id    uuid NOT NULL REFERENCES public.shopping_trips(id) ON DELETE CASCADE,
  tenant_id  uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  store_id   uuid NOT NULL REFERENCES public.stores(id) ON DELETE CASCADE,
  -- Free text: transport, food, parking, tolls, loading, anything else.
  label      text NOT NULL,
  amount     integer NOT NULL CHECK (amount >= 0),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS shopping_trip_expenses_trip ON public.shopping_trip_expenses(trip_id);

-- ---------------------------------------------------------------------- RLS
-- Read: same rule as purchases — the tenant's owner/manager, scoped to their
-- store. Write: no policy at all, so only SECURITY DEFINER functions can insert.
ALTER TABLE public.shopping_trips ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.shopping_trip_expenses ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS shopping_trips_read ON public.shopping_trips;
CREATE POLICY shopping_trips_read ON public.shopping_trips FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.current_staff() u
     WHERE u.tenant_id = shopping_trips.tenant_id
       AND u.role IN ('owner', 'manager')
       AND (u.store_id IS NULL OR u.store_id = shopping_trips.store_id)
  ));

DROP POLICY IF EXISTS shopping_trip_expenses_read ON public.shopping_trip_expenses;
CREATE POLICY shopping_trip_expenses_read ON public.shopping_trip_expenses FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.current_staff() u
     WHERE u.tenant_id = shopping_trip_expenses.tenant_id
       AND u.role IN ('owner', 'manager')
       AND (u.store_id IS NULL OR u.store_id = shopping_trip_expenses.store_id)
  ));

-- Per table and explicit: 011's catalogue sweep ran before this migration, so
-- nothing else will ever lock these two down.
REVOKE ALL ON TABLE public.shopping_trips FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.shopping_trip_expenses FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.shopping_trips TO authenticated;
GRANT SELECT ON TABLE public.shopping_trip_expenses TO authenticated;

-- ============================================================================
-- engine_save_trip
--
-- p_items:        [{"variant_id": uuid, "quantity": int, "unit_cost": int}, …]
-- p_expenses:     [{"label": text, "amount": int}, …]
-- p_trip_date:    optional; the day the journey happened
-- p_request:      idempotency key — the same key returns the same trip
--
-- The whole thing is one transaction: a bad variant rolls back the purchase and
-- the stock too, so a half-saved trip can never leave stock and cost disagreeing.
-- ============================================================================
CREATE OR REPLACE FUNCTION public.engine_save_trip(
  p_store uuid,
  p_tenant uuid,
  p_supplier uuid,
  p_trip_date date,
  p_items jsonb,
  p_expenses jsonb,
  p_request uuid,
  p_notes text DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  staff uuid;
  supplier public.suppliers;
  previous public.shopping_trips;
  result uuid;
  purchase uuid;
  item record;
  spend record;
  old_qty bigint;
  old_cost numeric;
  goods numeric;
  extras numeric;
  units bigint;
  spread integer;
  amount numeric;
BEGIN
  staff := public.engine_staff(p_store, p_tenant);

  IF p_request IS NULL THEN RAISE EXCEPTION 'طلب شراء بدون مفتاح تكرار'; END IF;
  IF jsonb_typeof(p_items) IS DISTINCT FROM 'array' OR jsonb_array_length(p_items) = 0 THEN
    RAISE EXCEPTION 'أضف منتجاً واحداً على الأقل إلى الرحلة';
  END IF;
  IF jsonb_array_length(p_items) > 200 THEN RAISE EXCEPTION 'الحد الأقصى 200 بند في الرحلة'; END IF;
  IF p_expenses IS NOT NULL AND jsonb_typeof(p_expenses) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'مصاريف الرحلة غير صالحة';
  END IF;

  -- Same idempotency shape as engine_receive_purchase: a retried request with
  -- different values is a client bug, not a second trip.
  PERFORM pg_advisory_xact_lock(hashtextextended(p_request::text, 0));
  SELECT * INTO previous FROM public.shopping_trips WHERE request_id = p_request;
  IF FOUND THEN
    IF previous.store_id IS DISTINCT FROM p_store
       OR previous.tenant_id IS DISTINCT FROM p_tenant
       OR previous.supplier_id IS DISTINCT FROM p_supplier
    THEN RAISE EXCEPTION 'طلب رحلة مكرر بقيم مختلفة'; END IF;
    RETURN previous.id;
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(p_tenant::text, 1));

  -- ---------------------------------------------------------------- supplier
  -- Optional: a trip can be a market run with no registered supplier.
  IF p_supplier IS NOT NULL THEN
    SELECT * INTO supplier FROM public.suppliers
     WHERE id = p_supplier AND tenant_id = p_tenant AND store_id = p_store FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'المورد غير موجود في هذا المتجر'; END IF;
  END IF;

  -- ------------------------------------------------------------------- items
  IF EXISTS (
    SELECT 1 FROM jsonb_to_recordset(p_items) AS x(variant_id uuid, quantity numeric, unit_cost numeric)
     WHERE variant_id IS NULL OR quantity IS NULL OR quantity <= 0 OR quantity <> trunc(quantity)
        OR quantity > 2147483647 OR unit_cost IS NULL OR unit_cost < 0
        OR unit_cost <> trunc(unit_cost) OR unit_cost > 2147483647
  ) THEN RAISE EXCEPTION 'الكميات والتكاليف يجب أن تكون أعداداً صحيحة صالحة'; END IF;

  IF (SELECT count(*) FROM jsonb_to_recordset(p_items) AS x(variant_id uuid))
     <> (SELECT count(DISTINCT variant_id) FROM jsonb_to_recordset(p_items) AS x(variant_id uuid)) THEN
    RAISE EXCEPTION 'لا تكرر نفس المقاس في الرحلة';
  END IF;

  -- ---------------------------------------------------------------- expenses
  IF EXISTS (
    SELECT 1 FROM jsonb_to_recordset(coalesce(p_expenses, '[]'::jsonb)) AS e(label text, amount numeric)
     WHERE amount IS NULL OR amount < 0 OR amount <> trunc(amount) OR amount > 2147483647
        OR label IS NULL OR btrim(label) = ''
  ) THEN RAISE EXCEPTION 'أدخل وصفاً ومبلغاً صحيحاً لكل مصروف رحلة'; END IF;

  SELECT coalesce(sum(quantity * unit_cost), 0), coalesce(sum(quantity), 0)
    INTO goods, units
    FROM jsonb_to_recordset(p_items) AS x(quantity numeric, unit_cost numeric);
  IF units <= 0 THEN RAISE EXCEPTION 'إجمالي الكميات غير صالح'; END IF;

  SELECT coalesce(sum(amount), 0) INTO extras
    FROM jsonb_to_recordset(coalesce(p_expenses, '[]'::jsonb)) AS e(amount numeric);

  IF goods > 2147483647 OR extras > 2147483647 THEN RAISE EXCEPTION 'إجمالي الرحلة كبير جداً'; END IF;

  -- The whole point of the feature: the journey is split across every unit
  -- bought, then folded into cost. Floored, so the stored cost is an integer
  -- like every other money column in this schema.
  spread := floor(extras / units);

  -- ------------------------------------------------------------- the purchase
  -- A real purchase row, so the goods appear in مشتريات and the supplier's
  -- debt moves exactly as a receipt from the purchases screen would. Trip
  -- expenses are deliberately NOT part of total_amount: the supplier did not
  -- charge us for the bus fare.
  INSERT INTO public.purchases(
    store_id, tenant_id, supplier_id, supplier_name, total_amount, status,
    created_by, request_id, request_items, description, created_at
  ) VALUES (
    p_store, p_tenant, p_supplier, supplier.name, goods, 'received',
    staff, p_request, p_items,
    'رحلة شراء' || CASE WHEN p_trip_date IS NULL THEN '' ELSE ' بتاريخ ' || p_trip_date::text END,
    -- The trip happened on p_trip_date, so its invoice is dated then, not now.
    coalesce(p_trip_date::timestamptz + time '12:00', now())
  ) RETURNING id INTO purchase;

  -- --------------------------------------------------------------- the goods
  FOR item IN
    SELECT * FROM jsonb_to_recordset(p_items) AS x(variant_id uuid, quantity integer, unit_cost integer)
     ORDER BY variant_id
  LOOP
    SELECT v.cost_price_avg INTO old_cost
      FROM public.product_variants v JOIN public.products p ON p.id = v.product_id
     WHERE v.id = item.variant_id AND p.tenant_id = p_tenant FOR UPDATE OF v;
    IF NOT FOUND THEN RAISE EXCEPTION 'المقاس لا ينتمي إلى المؤسسة'; END IF;

    PERFORM i.id FROM public.inventory i WHERE i.variant_id = item.variant_id FOR UPDATE;
    -- cost_price_avg is shared by the variant across the tenant, so weight all
    -- of the tenant's stock, not only this store's.
    SELECT coalesce(sum(i.quantity), 0) INTO old_qty
      FROM public.inventory i JOIN public.stores s ON s.id = i.store_id
     WHERE i.variant_id = item.variant_id AND s.tenant_id = p_tenant;
    IF old_qty < 0 THEN RAISE EXCEPTION 'لا يمكن حساب التكلفة لمخزون سالب'; END IF;

    -- unit true cost = goods unit cost + this trip's share of the journey
    amount := ((old_qty * coalesce(old_cost, 0))
               + (item.quantity::numeric * (item.unit_cost + spread)))
              / (old_qty + item.quantity);
    UPDATE public.product_variants SET cost_price_avg = amount WHERE id = item.variant_id;

    INSERT INTO public.purchase_items(purchase_id, variant_id, quantity, unit_cost, tenant_id, store_id)
      VALUES (purchase, item.variant_id, item.quantity, item.unit_cost, p_tenant, p_store);

    INSERT INTO public.inventory(store_id, variant_id, quantity)
      VALUES (p_store, item.variant_id, item.quantity)
      ON CONFLICT (store_id, variant_id)
      DO UPDATE SET quantity = inventory.quantity + excluded.quantity, updated_at = now();
  END LOOP;

  -- -------------------------------------------------------------- the history
  INSERT INTO public.shopping_trips(
    tenant_id, store_id, supplier_id, supplier_name, trip_date, notes,
    goods_cost, trip_expenses, cost_per_unit, total_units, purchase_id, created_by, request_id
  ) VALUES (
    p_tenant, p_store, p_supplier, supplier.name, coalesce(p_trip_date, current_date), p_notes,
    goods::integer, extras::integer, spread, units::integer, purchase, staff, p_request
  ) RETURNING id INTO result;

  INSERT INTO public.shopping_trip_expenses(trip_id, tenant_id, store_id, label, amount)
  SELECT result, p_tenant, p_store, btrim(e.label), e.amount::integer
    FROM jsonb_to_recordset(coalesce(p_expenses, '[]'::jsonb)) AS e(label text, amount integer);

  -- The supplier owes movement only for the goods, same as a normal receipt.
  IF p_supplier IS NOT NULL THEN
    UPDATE public.suppliers SET total_debt = coalesce(total_debt, 0) + goods::integer
     WHERE id = p_supplier;
  END IF;

  RETURN result;
END $$;

REVOKE ALL ON FUNCTION public.engine_save_trip(uuid,uuid,uuid,date,jsonb,jsonb,uuid,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.engine_save_trip(uuid,uuid,uuid,date,jsonb,jsonb,uuid,text) TO authenticated;
