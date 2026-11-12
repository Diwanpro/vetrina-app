-- Fix: products.images is text[], not jsonb.
--
-- The public storefront failed with
--   COALESCE types text[] and jsonb cannot be matched
-- because get_store_products defaulted the column to '[]'::jsonb. 202611120005
-- is corrected for fresh databases; this migration replaces the function on
-- databases that already ran it.
--
-- The same audit covered every other RPC: no other function reads `images`, and
-- the remaining text[]/jsonb uses are deliberate (`p_roles text[]`,
-- `jsonb_build_object` results, `sync_items jsonb`). Nothing else changed.
--
-- Idempotent. Apply after 202611120005.

CREATE OR REPLACE FUNCTION public.get_store_products(p_store_id uuid)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE s public.stores; result jsonb;
BEGIN
  SELECT * INTO s FROM public.stores
   WHERE id = p_store_id AND coalesce(store_enabled, false);
  IF NOT FOUND THEN RETURN '[]'::jsonb; END IF;

  SELECT coalesce(jsonb_agg(entry ORDER BY sort_name, sort_id), '[]'::jsonb)
    INTO result
    FROM (
      SELECT jsonb_build_object(
               'id', p.id,
               'name', p.name,
               'description', p.description,
               'category', p.category,
               'subcategory', p.subcategory,
               'image_url', p.image_url,
               -- products.images is text[], so the jsonb_build_object converts it.
               'images', coalesce(p.images, ARRAY[]::text[]),
               -- Prices are hidden from the storefront, but create_order always
               -- prices server-side, so the cart still works.
               'base_price', CASE WHEN coalesce(s.show_prices, true) THEN p.base_price ELSE NULL END,
               'variants', (
                 SELECT coalesce(jsonb_agg(jsonb_build_object(
                          'id', v.id,
                          'color', v.color,
                          'size', v.size,
                          'available', (i.quantity - coalesce(i.reserved_qty, 0))
                        ) ORDER BY v.size NULLS LAST, v.color), '[]'::jsonb)
                   FROM public.product_variants v
                   JOIN public.inventory i
                     ON i.variant_id = v.id AND i.store_id = s.id
                  WHERE v.product_id = p.id
                    AND (i.quantity - coalesce(i.reserved_qty, 0)) > 0
               ),
               'offers', (
                 SELECT coalesce(jsonb_agg(jsonb_build_object(
                          'id', o.id,
                          'variant_id', o.variant_id,
                          'kind', CASE WHEN o.discount_percentage IS NOT NULL THEN 'percent' ELSE 'bundle' END,
                          'discount_percentage', o.discount_percentage,
                          'required_qty', o.required_qty,
                          'offer_price', o.offer_price,
                          'name', o.name,
                          'description', o.description
                        ) ORDER BY o.created_at DESC), '[]'::jsonb)
                   FROM public.offers o
                  WHERE o.tenant_id = s.tenant_id
                    AND o.product_id = p.id
                    AND coalesce(o.is_active, true)
               )
             ) AS entry,
             p.name AS sort_name,
             p.id AS sort_id
        FROM public.products p
       WHERE p.tenant_id = s.tenant_id
         AND p.is_active
         -- A product with nothing sellable in this store is not listed at all.
         AND EXISTS (
           SELECT 1 FROM public.product_variants v
             JOIN public.inventory i ON i.variant_id = v.id AND i.store_id = s.id
            WHERE v.product_id = p.id
              AND (i.quantity - coalesce(i.reserved_qty, 0)) > 0)
         -- Optional merchandising rule: only show products that have a picture.
         AND (NOT coalesce(s.hide_products_without_image, true)
              OR nullif(btrim(coalesce(p.image_url, '')), '') IS NOT NULL
              -- array_length, not jsonb_array_length: this column is text[].
              OR coalesce(array_length(p.images, 1), 0) > 0)
    ) sorted;

  RETURN result;
END $$;
