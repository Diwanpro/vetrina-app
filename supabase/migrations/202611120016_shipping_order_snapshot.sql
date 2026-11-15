-- P3: read-only order snapshot for the shipping gateway.
--
-- The gateway must never write to public.orders (approved constraint). It also
-- should not need a direct table SELECT: this definer RPC returns exactly the
-- fields a courier needs, after re-checking the caller's tenant and branch.
-- No ALTER / UPDATE / INSERT / DELETE on public.orders anywhere in this file.
--
-- Apply after 202611120015. Idempotent (CREATE OR REPLACE FUNCTION).

CREATE OR REPLACE FUNCTION public.engine_order_shipping_snapshot(p_order_id uuid)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  u public.users;
  o public.orders;
BEGIN
  SELECT * INTO u FROM public.current_staff();
  IF u.id IS NULL OR u.role NOT IN ('owner','manager','employee') THEN
    RAISE EXCEPTION 'غير مصرح';
  END IF;

  SELECT * INTO o FROM public.orders WHERE id = p_order_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'الطلب غير موجود'; END IF;
  IF o.tenant_id IS DISTINCT FROM u.tenant_id THEN RAISE EXCEPTION 'غير مصرح'; END IF;
  IF u.role <> 'owner' AND u.store_id IS DISTINCT FROM o.store_id THEN
    RAISE EXCEPTION 'غير مصرح لهذا الفرع';
  END IF;

  RETURN jsonb_build_object(
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
  );
END $$;

REVOKE ALL ON FUNCTION public.engine_order_shipping_snapshot(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.engine_order_shipping_snapshot(uuid) TO authenticated;
