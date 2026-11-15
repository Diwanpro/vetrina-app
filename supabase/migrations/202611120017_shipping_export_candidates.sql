-- P4: CSV bulk-export candidates + duplicate guards.
--
-- The export gateway must never write to public.orders. It reads eligible
-- orders through this read-only definer RPC, then records the batch in the new
-- shipping tables only. No ALTER/UPDATE/INSERT/DELETE on public.orders here.
--
-- Apply after 202611120016. Idempotent: CREATE OR REPLACE + IF NOT EXISTS.

-- One order may be exported once, to any courier. The batch/order index from
-- P1 protects a single batch; these two indexes protect all later batches.
CREATE UNIQUE INDEX IF NOT EXISTS shipping_export_items_order_once
  ON public.shipping_export_items (tenant_id, order_id);

CREATE UNIQUE INDEX IF NOT EXISTS shipments_bulk_export_once
  ON public.shipments (order_id)
  WHERE mode = 'bulk' AND status = 'exported';

CREATE OR REPLACE FUNCTION public.engine_shipping_export_candidates(p_store uuid, p_provider_code text)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  u public.users;
  v_tenant uuid;
BEGIN
  SELECT * INTO u FROM public.current_staff();
  IF u.id IS NULL OR u.role NOT IN ('owner','manager','employee') THEN
    RAISE EXCEPTION 'غير مصرح';
  END IF;

  SELECT tenant_id INTO v_tenant FROM public.stores WHERE id = p_store;
  IF v_tenant IS NULL OR v_tenant IS DISTINCT FROM u.tenant_id THEN
    RAISE EXCEPTION 'غير مصرح لهذا الفرع';
  END IF;
  IF u.role <> 'owner' AND u.store_id IS DISTINCT FROM p_store THEN
    RAISE EXCEPTION 'غير مصرح لهذا الفرع';
  END IF;
  IF p_provider_code IS NULL OR p_provider_code !~ '^[a-z0-9_]{2,40}$' THEN
    RAISE EXCEPTION 'شركة التوصيل غير صالحة';
  END IF;

  RETURN coalesce((
    SELECT jsonb_agg(jsonb_build_object(
      'id', o.id,
      'order_number', o.order_number,
      'status', o.status,
      'fulfillment_type', o.fulfillment_type,
      'customer_name', o.customer_name,
      'customer_phone', o.customer_phone,
      'wilaya_code', o.wilaya_code,
      'commune', o.commune,
      'address', o.address,
      'note', o.note,
      'total', o.total,
      'delivery_fee', o.delivery_fee,
      'store_id', o.store_id,
      'tenant_id', o.tenant_id,
      'created_at', o.created_at,
      'items', coalesce((
        SELECT jsonb_agg(jsonb_build_object(
          'product_name', i.product_name,
          'qty', i.qty,
          'unit_price', i.unit_price,
          'size', i.size,
          'color', i.color,
          'line_total', i.line_total
        ) ORDER BY i.product_name)
        FROM public.order_items i WHERE i.order_id = o.id
      ), '[]'::jsonb)
    ) ORDER BY o.created_at DESC)
    FROM (
      SELECT * FROM public.orders o
      WHERE o.store_id = p_store
        AND o.tenant_id = v_tenant
        AND o.fulfillment_type = 'delivery'
        AND o.status IN ('confirmed','preparing')
        AND NOT EXISTS (
          SELECT 1 FROM public.shipments s
          WHERE s.order_id = o.id
            AND s.tenant_id = v_tenant
            AND s.status NOT IN ('cancelled','failed')
        )
        AND NOT EXISTS (
          SELECT 1 FROM public.shipping_export_items ei
          WHERE ei.order_id = o.id
            AND ei.tenant_id = v_tenant
        )
      ORDER BY o.created_at DESC
      LIMIT 500
    ) o
  ), '[]'::jsonb);
END $$;

REVOKE ALL ON FUNCTION public.engine_shipping_export_candidates(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.engine_shipping_export_candidates(uuid, text) TO authenticated;
