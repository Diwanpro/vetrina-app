-- Offers belong to a product, not to a single size or colour.
--
-- A customer who buys one medium and one large of the same shirt bought two
-- shirts, so a "2 for 3000" bundle has to count both. The POS now groups cart
-- lines by product; this migration lets the offer itself be stored that way.
--
-- Variant-level offers are still accepted (p_variant is optional) so rows
-- created by the earlier version keep working and can be edited.

ALTER TABLE public.offers ALTER COLUMN variant_id DROP NOT NULL;

CREATE OR REPLACE FUNCTION public.engine_save_offer(
  p_tenant uuid, p_product uuid, p_variant uuid, p_kind text,
  p_discount integer, p_required_qty integer, p_offer_price integer, p_name text
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE u public.users; result uuid;
BEGIN
  SELECT * INTO u FROM public.current_staff();
  IF u.id IS NULL OR u.tenant_id IS DISTINCT FROM p_tenant OR u.role NOT IN ('owner','manager') THEN
    RAISE EXCEPTION 'غير مصرح بإدارة العروض';
  END IF;

  IF p_product IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.products p
    WHERE p.id = p_product AND p.tenant_id = p_tenant AND p.is_active = true
  ) THEN RAISE EXCEPTION 'المنتج غير صالح'; END IF;

  -- Optional: an offer may still target one variant when it predates this rule.
  IF p_variant IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.product_variants v
    WHERE v.id = p_variant AND v.product_id = p_product
  ) THEN RAISE EXCEPTION 'المقاس لا ينتمي إلى هذا المنتج'; END IF;

  IF p_kind = 'percent' THEN
    IF p_discount IS NULL OR p_discount <= 0 OR p_discount >= 100 THEN RAISE EXCEPTION 'نسبة الخصم غير صالحة'; END IF;
    p_required_qty := NULL; p_offer_price := NULL;
  ELSIF p_kind = 'bundle' THEN
    IF p_required_qty IS NULL OR p_required_qty < 2 OR p_offer_price IS NULL OR p_offer_price <= 0
    THEN RAISE EXCEPTION 'بيانات عرض الحزمة غير صالحة'; END IF;
    p_discount := NULL;
  ELSE
    RAISE EXCEPTION 'نوع العرض غير صالح';
  END IF;

  -- One active offer per product, so the POS never has to pick between two.
  UPDATE public.offers SET is_active = false
   WHERE tenant_id = p_tenant AND product_id = p_product
     AND variant_id IS NOT DISTINCT FROM p_variant
     AND coalesce(is_active, true);

  INSERT INTO public.offers(tenant_id, product_id, variant_id, discount_percentage,
                            required_qty, offer_price, name, is_active)
  VALUES (p_tenant, p_product, p_variant, p_discount, p_required_qty, p_offer_price,
          nullif(btrim(p_name), ''), true)
  RETURNING id INTO result;
  RETURN result;
END $$;

REVOKE ALL ON FUNCTION public.engine_save_offer(uuid,uuid,uuid,text,integer,integer,integer,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.engine_save_offer(uuid,uuid,uuid,text,integer,integer,integer,text) TO authenticated;
