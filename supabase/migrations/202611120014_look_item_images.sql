-- Fix: look items showed no picture when a product's photo lived in images[].
--
-- get_store_products() has always returned both `images` (text[]) and
-- `image_url`, and the storefront resolves them with productImage(): first a
-- usable entry in images[], then image_url. But get_store_looks() returned only
-- `p.image_url` for each look item. A product whose photo was uploaded into the
-- gallery array — which is what the dashboard writes now — therefore rendered
-- with no image inside a look, while the very same product looked fine on the
-- product grid. Two code paths, two answers, exactly the disagreement
-- productImage() was introduced to end.
--
-- This migration does two things:
--   1. adds public.first_image_url(text[], text), one SQL definition of the
--      precedence productImage() implements in JS;
--   2. replaces get_store_looks() so each look and each look item carries
--      `images`, the raw `image_url`, and an `image_url` already resolved
--      through that helper.
--
-- Resolving in SQL as well as in JS is deliberate: the array column is text[]
-- and arrives as a JSON array, but a client that forgets to call the helper
-- must not silently fall back to the old wrong answer. Both agree because the
-- helper is the same rule, expressed twice, and the tests pin them together.
--
-- Idempotent. Apply after 202611120012.

-- The one place SQL decides which picture represents a product.
-- Returns NULL (never an empty string) when there is nothing usable, so the
-- client can treat "no picture" and "" identically. Blank and null entries are
-- skipped exactly as productImage() skips them: an interrupted upload leaves
-- those behind, and picking one would render a broken image.
CREATE OR REPLACE FUNCTION public.first_image_url(p_images text[], p_image_url text)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT coalesce(
    (SELECT btrim(entry) FROM unnest(coalesce(p_images, ARRAY[]::text[])) AS entry
      WHERE nullif(btrim(coalesce(entry, '')), '') IS NOT NULL
      LIMIT 1),
    nullif(btrim(coalesce(p_image_url, '')), '')
  );
$$;

REVOKE ALL ON FUNCTION public.first_image_url(text[], text) FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON FUNCTION public.first_image_url(text[], text) FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON FUNCTION public.first_image_url(text[], text) FROM authenticated;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.get_store_looks(p_slug text)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE s public.stores;
BEGIN
  SELECT * INTO s FROM public.stores
   WHERE slug = p_slug AND coalesce(store_enabled, false);
  IF NOT FOUND THEN RETURN '[]'::jsonb; END IF;

  RETURN (
    SELECT coalesce(jsonb_agg(jsonb_build_object(
             'id', l.id, 'name', l.name, 'description', l.description,
             -- The look's own cover is a single column and needs no fallback,
             -- but it goes through the helper so a blank value becomes NULL
             -- rather than an empty src="" that re-requests the page.
             'image_url', public.first_image_url(NULL, l.image_url),
             'images', CASE
                         WHEN nullif(btrim(coalesce(l.image_url, '')), '') IS NULL THEN '[]'::jsonb
                         ELSE jsonb_build_array(btrim(l.image_url))
                       END,
             'video_url', l.video_url,
             'bundle_price', CASE WHEN coalesce(s.show_prices, true) THEN l.bundle_price ELSE NULL END,
             'items', (
               SELECT coalesce(jsonb_agg(jsonb_build_object(
                        'product_id', p.id,
                        'variant_id', li.variant_id,
                        'name', p.name,
                        -- Both halves, resolved: the raw column plus the
                        -- array-aware answer the storefront actually draws.
                        'image_url', public.first_image_url(p.images, p.image_url),
                        'images', coalesce(p.images, ARRAY[]::text[]),
                        'base_price', CASE WHEN coalesce(s.show_prices, true) THEN p.base_price ELSE NULL END,
                        -- create_order() applies at most one offer per product. If a
                        -- live one exists, that discount is what the customer pays and
                        -- the outfit price cannot stack on top — the storefront uses
                        -- this flag to say so instead of quoting a price it will not charge.
                        'has_offer', EXISTS (
                          SELECT 1 FROM public.offers o
                           WHERE o.tenant_id = s.tenant_id
                             AND o.product_id = p.id
                             AND coalesce(o.is_active, true)),
                        'variants', (
                          SELECT coalesce(jsonb_agg(jsonb_build_object(
                                   'id', v.id, 'color', v.color, 'size', v.size,
                                   'available', (i.quantity - coalesce(i.reserved_qty, 0))
                                 ) ORDER BY v.size NULLS LAST, v.color), '[]'::jsonb)
                            FROM public.product_variants v
                            JOIN public.inventory i
                              ON i.variant_id = v.id AND i.store_id = s.id
                           WHERE v.product_id = p.id
                             AND (i.quantity - coalesce(i.reserved_qty, 0)) > 0
                        )
                      ) ORDER BY p.name), '[]'::jsonb)
                 FROM public.look_items li
                 JOIN public.products p ON p.id = li.product_id
                WHERE li.look_id = l.id
                  AND coalesce(p.is_active, true)
                  -- A look showing nothing sellable in this shop is not shown.
                  AND EXISTS (
                    SELECT 1 FROM public.product_variants v
                      JOIN public.inventory i ON i.variant_id = v.id AND i.store_id = s.id
                     WHERE v.product_id = p.id
                       AND (i.quantity - coalesce(i.reserved_qty, 0)) > 0))
             ) ORDER BY l.created_at DESC), '[]'::jsonb)
      FROM public.looks l
     WHERE l.tenant_id = s.tenant_id
       AND coalesce(l.is_active, true)
       AND EXISTS (
         SELECT 1 FROM public.look_items li
           JOIN public.products p ON p.id = li.product_id
          WHERE li.look_id = l.id
            AND coalesce(p.is_active, true))
  );
END $$;

-- Same grants the previous definition had. Guarded, because a bare database
-- (a throwaway one in a test harness, for instance) may not have these roles.
REVOKE ALL ON FUNCTION public.get_store_looks(text) FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON FUNCTION public.get_store_looks(text) FROM anon;
    GRANT EXECUTE ON FUNCTION public.get_store_looks(text) TO anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON FUNCTION public.get_store_looks(text) FROM authenticated;
    GRANT EXECUTE ON FUNCTION public.get_store_looks(text) TO authenticated;
  END IF;
END $$;
