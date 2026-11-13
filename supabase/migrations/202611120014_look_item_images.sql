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

-- ============================================ the staff-facing look readers
-- get_store_looks() feeds the public storefront; these two feed the dashboard
-- and the POS. Both had the same defect: each returned only p.image_url for a
-- product, so a piece whose photos live in images[] drew an empty square in
-- the looks screen and in the POS look picker, even though the product grid
-- showed it fine. They now return `images` alongside a resolved `image_url`
-- from first_image_url(), which is the rule productImage() applies in JS.

-- p_store is optional. The looks screen passes nothing and gets the look as
-- authored; the POS passes its branch and also gets, per item, the variants
-- that are sellable *there*, so a cashier only sees sizes they can hand over.
-- Without it the POS would have to guess from base_price and could ring an
-- outfit containing a size the branch does not stock.
CREATE OR REPLACE FUNCTION public.engine_looks_list(p_store uuid DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE u public.users;
BEGIN
  SELECT * INTO u FROM public.current_staff();
  IF u.id IS NULL THEN RAISE EXCEPTION 'غير مصرح'; END IF;

  RETURN (
    SELECT coalesce(jsonb_agg(jsonb_build_object(
             'id', l.id, 'name', l.name, 'description', l.description,
             'image_url', public.first_image_url(NULL, l.image_url),
             'images', CASE
                         WHEN nullif(btrim(coalesce(l.image_url, '')), '') IS NULL THEN '[]'::jsonb
                         ELSE jsonb_build_array(btrim(l.image_url))
                       END,
             'video_url', l.video_url,
             'bundle_price', l.bundle_price, 'is_active', l.is_active,
             'created_at', l.created_at,
             'items', (
               SELECT coalesce(jsonb_agg(jsonb_build_object(
                        'id', li.id, 'product_id', li.product_id,
                        'variant_id', li.variant_id,
                        'product_name', p.name, 'base_price', p.base_price,
                        'image_url', public.first_image_url(p.images, p.image_url),
                        'images', coalesce(p.images, ARRAY[]::text[]),
                        'size', v.size, 'color', v.color,
                        -- Sellable variants in the branch the caller named. When
                        -- p_store is NULL this is empty and the caller uses only
                        -- variant_id / size / color, which is what the looks
                        -- screen wants.
                        'variants', CASE WHEN p_store IS NULL THEN '[]'::jsonb ELSE (
                          SELECT coalesce(jsonb_agg(jsonb_build_object(
                                   'id', sv.id, 'color', sv.color, 'size', sv.size,
                                   'available', (si.quantity - coalesce(si.reserved_qty, 0))
                                 ) ORDER BY (si.quantity - coalesce(si.reserved_qty, 0)) DESC,
                                          sv.size NULLS LAST, sv.color), '[]'::jsonb)
                            FROM public.product_variants sv
                            JOIN public.inventory si
                              ON si.variant_id = sv.id AND si.store_id = p_store
                           WHERE sv.product_id = p.id
                             AND (si.quantity - coalesce(si.reserved_qty, 0)) > 0
                        ) END
                      ) ORDER BY p.name), '[]'::jsonb)
                 FROM public.look_items li
                 JOIN public.products p ON p.id = li.product_id
                 LEFT JOIN public.product_variants v ON v.id = li.variant_id
                WHERE li.look_id = l.id)
           ) ORDER BY l.created_at DESC), '[]'::jsonb)
      FROM public.looks l
     WHERE l.tenant_id = u.tenant_id
  );
END $$;

CREATE OR REPLACE FUNCTION public.engine_look_catalog(p_store uuid)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE u public.users; s public.stores;
BEGIN
  SELECT * INTO u FROM public.current_staff();
  SELECT * INTO s FROM public.stores WHERE id = p_store AND tenant_id = u.tenant_id;
  IF u.id IS NULL OR NOT FOUND THEN RAISE EXCEPTION 'غير مصرح'; END IF;

  RETURN (
    SELECT coalesce(jsonb_agg(jsonb_build_object(
             'id', p.id, 'name', p.name, 'base_price', p.base_price,
             'image_url', public.first_image_url(p.images, p.image_url),
             'images', coalesce(p.images, ARRAY[]::text[]),
             'category', p.category,
             'variants', (
               SELECT coalesce(jsonb_agg(jsonb_build_object(
                        'id', v.id, 'color', v.color, 'size', v.size,
                        'available', coalesce(i.quantity - coalesce(i.reserved_qty, 0), 0)
                      ) ORDER BY v.size NULLS LAST, v.color), '[]'::jsonb)
                 FROM public.product_variants v
                 LEFT JOIN public.inventory i ON i.variant_id = v.id AND i.store_id = s.id
                WHERE v.product_id = p.id)
           ) ORDER BY p.name), '[]'::jsonb)
      FROM public.products p
     WHERE p.tenant_id = u.tenant_id AND coalesce(p.is_active, true)
  );
END $$;

-- Same grants these two already had.
-- ============================================ bundle split: by price, not by head
-- The equal split this replaces divided bundle_price by the item count. That is
-- wrong as soon as the pieces are not interchangeable: an outfit of an 8 200
-- jacket and a 1 900 tee at 10 000 gave the tee 5 000 (a 3 100 markup) and the
-- jacket 5 000 — and the staff sync path rejects any line priced below the
-- variant's min_price, so a look whose bundle_price sits close to the sum of its
-- pieces could not be sold at the till at all.
--
-- Proportionally, every piece keeps its share of the total and no unit can fall
-- below min_price unless the outfit itself is priced below the sum of the
-- floors. largest-remainder keeps the sum exact, and the last product by name
-- still absorbs any rounding difference so the result is stable.
CREATE OR REPLACE FUNCTION public.looks_bundle_units(p_look uuid)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  l public.looks; units integer; total bigint; gross bigint; leftovers bigint;
BEGIN
  SELECT * INTO l FROM public.looks WHERE id = p_look;
  IF NOT FOUND OR l.bundle_price IS NULL OR l.bundle_price <= 0 THEN RETURN '{}'::jsonb; END IF;

  units := (SELECT count(*) FROM public.look_items WHERE look_id = p_look);
  IF units < 2 THEN RETURN '{}'::jsonb; END IF;

  total := l.bundle_price;
  gross := (SELECT sum(p.base_price)
              FROM public.look_items li
              JOIN public.products p ON p.id = li.product_id
             WHERE li.look_id = p_look);

  -- No usable catalogue prices: keep the old equal split rather than refuse to
  -- price the outfit at all.
  IF coalesce(gross, 0) <= 0 THEN
    RETURN (
      SELECT jsonb_object_agg(ranked.product_id, ranked.unit)
        FROM (
          SELECT li.product_id,
                 row_number() OVER (ORDER BY p.name, li.product_id) AS position,
                 CASE WHEN row_number() OVER (ORDER BY p.name, li.product_id) = units
                      THEN total - (total / units) * (units - 1)
                      ELSE total / units END AS unit
            FROM public.look_items li
            JOIN public.products p ON p.id = li.product_id
           WHERE li.look_id = p_look
        ) ranked);
  END IF;

  -- Largest remainder: floor each proportional share, then hand the leftover
  -- units to the biggest fractional parts. The sum is exactly bundle_price and
  -- the order is deterministic on (name, product_id) inside each tie group.
  SELECT total - sum(share.base) INTO leftovers
    FROM (
      SELECT (total * p.base_price) / gross AS base
        FROM public.look_items li
        JOIN public.products p ON p.id = li.product_id
       WHERE li.look_id = p_look
    ) share;

  RETURN (
    SELECT jsonb_object_agg(share.product_id, share.base + CASE WHEN share.position <= leftovers THEN 1 ELSE 0 END)
      FROM (
        SELECT li.product_id,
               row_number() OVER (
                 ORDER BY ((total * p.base_price) % gross) DESC, p.name, li.product_id
               ) AS position,
               (total * p.base_price) / gross AS base
          FROM public.look_items li
          JOIN public.products p ON p.id = li.product_id
         WHERE li.look_id = p_look
      ) share);
END $$;

-- The function is replaced in place, so its grants survive; re-stated so a fresh
-- database that only runs this migration also gets them.
REVOKE ALL ON FUNCTION public.looks_bundle_units(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.looks_bundle_units(uuid) TO anon, authenticated;

REVOKE ALL ON FUNCTION public.engine_looks_list(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.engine_look_catalog(uuid) FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON FUNCTION public.engine_looks_list(uuid) FROM anon;
    REVOKE ALL ON FUNCTION public.engine_look_catalog(uuid) FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    GRANT EXECUTE ON FUNCTION public.engine_looks_list(uuid) TO authenticated;
    GRANT EXECUTE ON FUNCTION public.engine_look_catalog(uuid) TO authenticated;
  END IF;
END $$;
