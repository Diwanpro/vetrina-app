-- A product can point at one social video (TikTok, Instagram, Facebook…).
--
-- The column is nullable on purpose: most products do not have one. The CHECK
-- keeps the column to http(s) URLs so a javascript: or data: link can never be
-- rendered as "watch the video" on the public store, and get_store_products
-- applies the same rule again on the way out.
--
-- Apply after 202611120009. Idempotent.

ALTER TABLE public.products
  ADD COLUMN IF NOT EXISTS external_video_url text;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'products_external_video_url_http') THEN
    ALTER TABLE public.products
      ADD CONSTRAINT products_external_video_url_http
      CHECK (external_video_url IS NULL OR external_video_url ~* '^https?://[^[:space:]]+$');
  END IF;
END $$;

COMMENT ON COLUMN public.products.external_video_url IS
  'Optional link to a TikTok / Instagram / Facebook video about this product.';

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
               -- Only http(s) links reach the storefront; anything else is dropped
               -- here rather than trusted to the client.
               'external_video_url', CASE
                 WHEN p.external_video_url ~* '^https?://[^[:space:]]+$' THEN p.external_video_url
                 ELSE NULL
               END,
               -- products.images is text[], so the jsonb_build_object converts it.
               'images', coalesce(p.images, ARRAY[]::text[]),
               -- Prices are hidden from the storefront, but create_order always
               -- prices server-side, so the cart still works.
               'base_price', CASE WHEN coalesce(s.show_prices, true) THEN p.base_price ELSE NULL END,
               -- Every variant this store stocks, sold out ones included, so
               -- the picker can grey them out instead of hiding them. The
               -- product itself is only listed when something is sellable.
               'variants', (
                 SELECT coalesce(jsonb_agg(jsonb_build_object(
                          'id', v.id,
                          'color', v.color,
                          'size', v.size,
                          'available', greatest(i.quantity - coalesce(i.reserved_qty, 0), 0)
                        ) ORDER BY
                          (greatest(i.quantity - coalesce(i.reserved_qty, 0), 0) > 0) DESC,
                          v.size NULLS LAST, v.color), '[]'::jsonb)
                   FROM public.product_variants v
                   JOIN public.inventory i
                     ON i.variant_id = v.id AND i.store_id = s.id
                  WHERE v.product_id = p.id
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

REVOKE ALL ON FUNCTION public.get_store_products(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_store_products(uuid) TO anon, authenticated;
