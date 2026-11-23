-- Live legacy tables require movement_type and quantity_change as well as
-- the newer ledger columns. Keep both representations explicit and consistent.
-- Add nullable compatibility columns on clean installs; do not loosen any live
-- constraints, add a global default, or change sale/purchase writers.
ALTER TABLE public.inventory_movements ADD COLUMN IF NOT EXISTS movement_type text;
ALTER TABLE public.inventory_movements ADD COLUMN IF NOT EXISTS quantity_change integer;

CREATE OR REPLACE FUNCTION public.engine_add_stock_manual(
  p_store uuid, p_tenant uuid, p_variant uuid,
  p_quantity integer, p_unit_cost numeric, p_request uuid
) RETURNS numeric
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE staff uuid; old_qty bigint; old_cost numeric; amount numeric;
BEGIN
  staff := public.engine_staff(p_store, p_tenant);
  IF p_quantity IS NULL OR p_quantity <= 0 THEN RAISE EXCEPTION 'الكمية غير صالحة'; END IF;
  IF p_unit_cost IS NULL OR p_unit_cost < 0 THEN RAISE EXCEPTION 'سعر التكلفة مطلوب'; END IF;
  IF p_request IS NULL THEN RAISE EXCEPTION 'طلب غير صالح'; END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(p_request::text, 0));
  IF EXISTS (SELECT 1 FROM public.inventory_movements WHERE request_id = p_request) THEN
    SELECT coalesce(v.cost_price_avg, 0) INTO amount FROM public.product_variants v WHERE v.id = p_variant;
    RETURN amount;
  END IF;

  SELECT v.cost_price_avg INTO old_cost
  FROM public.product_variants v JOIN public.products p ON p.id = v.product_id
  WHERE v.id = p_variant AND p.tenant_id = p_tenant FOR UPDATE OF v;
  IF NOT FOUND THEN RAISE EXCEPTION 'المقاس لا ينتمي إلى المؤسسة'; END IF;

  PERFORM i.id FROM public.inventory i WHERE i.variant_id = p_variant FOR UPDATE;

  -- cost_price_avg is shared by the variant, so weight every store in the
  -- tenant (same rule as engine_receive_purchase).
  SELECT coalesce(sum(i.quantity), 0) INTO old_qty
  FROM public.inventory i JOIN public.stores s ON s.id = i.store_id
  WHERE i.variant_id = p_variant AND s.tenant_id = p_tenant;
  IF old_qty < 0 THEN RAISE EXCEPTION 'لا يمكن حساب التكلفة لمخزون سالب'; END IF;

  amount := ((old_qty * coalesce(old_cost, 0)) + (p_quantity::numeric * p_unit_cost)) / (old_qty + p_quantity);

  UPDATE public.product_variants SET cost_price_avg = amount WHERE id = p_variant;
  INSERT INTO public.inventory(store_id, variant_id, quantity)
    VALUES (p_store, p_variant, p_quantity)
    ON CONFLICT (store_id, variant_id)
    DO UPDATE SET quantity = inventory.quantity + excluded.quantity, updated_at = now();
  INSERT INTO public.inventory_movements(tenant_id, store_id, variant_id, kind, quantity_delta, movement_type, quantity_change, unit_cost, request_id, created_by)
    VALUES (p_tenant, p_store, p_variant, 'adjustment', p_quantity, 'adjustment', p_quantity, p_unit_cost, p_request, staff);
  RETURN amount;
END $$;

