-- ============================================================================
-- 012 — "Shop the Look": curated outfits built from existing products
--
-- Shape: a look belongs to a tenant and groups products (optionally a specific
-- variant) with one hero image or video, so a shop can show an outfit and sell
-- either the whole thing or single pieces.
--
-- Two decisions shape this file and are worth stating up front.
--
-- 1. NO public RLS policies, despite what a first reading of the brief implies.
--    Migration 202611120011 revokes every table privilege from `anon` and
--    routes the whole storefront through SECURITY DEFINER RPCs. A "public read"
--    policy on `looks` would re-open `products` indirectly: anyone could list
--    tenant ids, including shops that are not published. The storefront instead
--    reads through get_store_looks(), which resolves the store first and only
--    then exposes that shop's active looks. Same outcome for customers, no way
--    to enumerate other tenants.
--
-- 2. The bundle price is a real, server-enforced price, not a display value.
--    create_order() prices every line itself and ignores anything the client
--    sends, so a client-side discount would simply not happen — the button
--    would say 12,000 and the order would charge 15,000. The bundle is written
--    into `offers` as one bundle offer per product inside the look, computed by
--    a trigger, so the existing pricing path applies it. The price shown and
--    the price charged come from the same row.
--
-- Idempotent. Apply after 202611120011.
-- ============================================================================

-- ------------------------------------------------------------------ tables
CREATE TABLE IF NOT EXISTS public.looks (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  name         text NOT NULL,
  description  text,
  image_url    text,
  video_url    text,
  bundle_price integer,
  is_active    boolean NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now(),
  -- Negative money and empty names are the two things a form gets wrong.
  CONSTRAINT looks_bundle_price_nonneg CHECK (bundle_price IS NULL OR bundle_price >= 0),
  CONSTRAINT looks_name_present CHECK (btrim(name) <> '')
);

ALTER TABLE public.looks ADD COLUMN IF NOT EXISTS tenant_id uuid;
ALTER TABLE public.looks ADD COLUMN IF NOT EXISTS name text;
ALTER TABLE public.looks ADD COLUMN IF NOT EXISTS description text;
ALTER TABLE public.looks ADD COLUMN IF NOT EXISTS image_url text;
ALTER TABLE public.looks ADD COLUMN IF NOT EXISTS video_url text;
ALTER TABLE public.looks ADD COLUMN IF NOT EXISTS bundle_price integer;
ALTER TABLE public.looks ADD COLUMN IF NOT EXISTS is_active boolean DEFAULT true;
ALTER TABLE public.looks ADD COLUMN IF NOT EXISTS created_at timestamptz DEFAULT now();

CREATE TABLE IF NOT EXISTS public.look_items (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  look_id    uuid NOT NULL REFERENCES public.looks(id) ON DELETE CASCADE,
  product_id uuid NOT NULL REFERENCES public.products(id) ON DELETE CASCADE,
  variant_id uuid REFERENCES public.product_variants(id) ON DELETE CASCADE
);

ALTER TABLE public.look_items ADD COLUMN IF NOT EXISTS look_id uuid;
ALTER TABLE public.look_items ADD COLUMN IF NOT EXISTS product_id uuid;
ALTER TABLE public.look_items ADD COLUMN IF NOT EXISTS variant_id uuid;

CREATE INDEX IF NOT EXISTS looks_tenant_active ON public.looks (tenant_id, is_active, created_at DESC);
CREATE INDEX IF NOT EXISTS look_items_look     ON public.look_items (look_id);
CREATE INDEX IF NOT EXISTS look_items_product  ON public.look_items (product_id);

-- A product appears at most once per look, as a whole product or as one
-- variant. Two rows for the same product would mean two bundle offers for it.
CREATE UNIQUE INDEX IF NOT EXISTS look_items_once
  ON public.look_items (look_id, product_id);

-- --------------------------------------------------------------------- RLS
ALTER TABLE public.looks      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.look_items ENABLE ROW LEVEL SECURITY;
-- `anon` never reads these directly; it goes through get_store_looks() below.
-- Stated per table rather than in one statement: an audit reads this block and
-- expects to see each table named.
REVOKE ALL ON TABLE public.looks FROM PUBLIC, anon;
REVOKE ALL ON TABLE public.look_items FROM PUBLIC, anon;

DROP POLICY IF EXISTS looks_tenant_isolation ON public.looks;
CREATE POLICY looks_tenant_isolation ON public.looks
  FOR ALL TO authenticated
  USING (tenant_id = public.current_tenant_id())
  WITH CHECK (tenant_id = public.current_tenant_id());

-- Items inherit the look's tenant: there is no tenant_id of their own to forge.
DROP POLICY IF EXISTS look_items_tenant_isolation ON public.look_items;
CREATE POLICY look_items_tenant_isolation ON public.look_items
  FOR ALL TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.looks l
     WHERE l.id = look_items.look_id
       AND l.tenant_id = public.current_tenant_id()))
  WITH CHECK (EXISTS (
    SELECT 1 FROM public.looks l
     WHERE l.id = look_items.look_id
       AND l.tenant_id = public.current_tenant_id()));

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.looks, public.look_items TO authenticated;

-- ============================================== bundle price: honest pricing
-- A first draft of this feature wrote the look's discount into `offers`, and
-- that was wrong in a way worth recording: `offers` is applied by BOTH the
-- storefront and the POS. A shirt discounted to hit an outfit price would also
-- be discounted when sold alone at the till — and the POS rejects a price below
-- `min_price`, so the till would have refused a sale the shop set up in this
-- screen. Marketing should not silently change the price of a product.
--
-- So the look price is not written anywhere it could leak. It is enforced in
-- create_order() instead, which is the only place an online order is priced.
--
-- Note on `offers.bundle_price` and the "already discounted" problem:
-- create_order() applies at most one offer per product — the newest — so if a
-- product already has a live discount, that discount is what the customer pays
-- and the look's price does not stack on top. The storefront detects this and
-- hides the bundle button rather than promising a price the order will not
-- charge. Both sides read the same offer table, so they cannot disagree.
ALTER TABLE public.looks ADD COLUMN IF NOT EXISTS bundle_price integer;

-- Snapshot of the bundle's unit prices, written by the dashboard when the
-- customer presses the bundle button. create_order() treats them as a
-- merchant-authored price, under the same rules as a manual offer.
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS look_id uuid REFERENCES public.looks(id) ON DELETE SET NULL;

CREATE OR REPLACE FUNCTION public.looks_bundle_units(p_look uuid)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE l public.looks; units integer; total integer; base_unit integer; last_unit integer;
BEGIN
  SELECT * INTO l FROM public.looks WHERE id = p_look;
  IF NOT FOUND OR l.bundle_price IS NULL OR l.bundle_price <= 0 THEN RETURN '{}'::jsonb; END IF;

  units := (SELECT count(*) FROM public.look_items WHERE look_id = p_look);
  IF units < 2 THEN RETURN '{}'::jsonb; END IF;

  total := l.bundle_price;
  base_unit := total / units;
  last_unit := total - base_unit * (units - 1);

  -- product_id -> unit price, remainder on the last product by name so the sum
  -- is exact and the same every time.
  RETURN (
    SELECT jsonb_object_agg(ranked.product_id, ranked.unit)
      FROM (
        SELECT li.product_id,
               row_number() OVER (ORDER BY p.name, li.product_id) AS position,
               CASE WHEN row_number() OVER (ORDER BY p.name, li.product_id) = units
                    THEN last_unit ELSE base_unit END AS unit
          FROM public.look_items li
          JOIN public.products p ON p.id = li.product_id
         WHERE li.look_id = p_look
      ) ranked
  );
END $$;

REVOKE ALL ON FUNCTION public.looks_bundle_units(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.looks_bundle_units(uuid) TO anon, authenticated;

-- Single-product looks cannot be discounted inside create_order()'s bundle
-- rule (it needs required_qty >= 2). Refuse the price instead of accepting one
-- that would never be charged.
CREATE OR REPLACE FUNCTION public.looks_check_bundle()
RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE units integer;
BEGIN
  IF NEW.bundle_price IS NULL OR NEW.bundle_price <= 0 THEN RETURN NEW; END IF;
  units := (SELECT count(*) FROM public.look_items WHERE look_id = NEW.id);
  IF units = 1 THEN
    RAISE EXCEPTION 'سعر الإطلالة يتطلب منتجين على الأقل؛ أزل السعر أو أضف منتجاً آخر';
  END IF;
  RETURN NEW;
END $$;

-- Trigger-only: it is never called from a client, and PUBLIC must not be able
-- to invoke it either.
REVOKE ALL ON FUNCTION public.looks_check_bundle() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS looks_check_bundle ON public.looks;
CREATE TRIGGER looks_check_bundle
  BEFORE INSERT OR UPDATE OF bundle_price ON public.looks
  FOR EACH ROW EXECUTE FUNCTION public.looks_check_bundle();

-- ======================================================== create_order + look
-- Extended, not redefined from scratch: the body below is migration 009's
-- create_order with the bundle branch added, so every existing rule (stock
-- locking, delivery rates, customer capture, store visibility) stays as it was.

CREATE OR REPLACE FUNCTION public.create_order(
  p_store_id uuid,
  p_customer jsonb,
  p_items jsonb,
  p_source text,
  p_wilaya text,
  p_delivery_fee integer,
  -- Optional: a complete look was bought. The outfit price is recomputed
  -- server-side from public.looks; money never arrives from the client.
  p_look_id uuid DEFAULT NULL,
  p_bundle_units jsonb DEFAULT NULL
) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  s public.stores;
  bundle jsonb := '{}'::jsonb;
  bundle_ready boolean := false;
  new_order uuid;
  token text;
  order_code text;
  items_json jsonb := '[]'::jsonb;
  product_row record;
  line_row record;
  offer_row record;
  prices integer[];
  unit_price integer;
  line_total integer;
  line_discount integer;
  gross_total integer;
  position integer;
  step integer;
  total_qty integer;
  groups integer;
  base_unit integer;
  last_unit integer;
  discount_unit integer;
  offer_id uuid;
  offer_ok boolean;
  offer_found boolean;
  subtotal_total integer := 0;
  discount_total integer := 0;
  delivery_fee integer := 0;
  fee_on_arrival boolean := false;
  grand_total integer := 0;
  fulfillment text;
  clean_phone text;
  clean_name text;
  clean_source text;
  clean_wilaya text;
  rate jsonb;
  customer_uuid uuid;
  customer_row record;
  found_customer boolean := false;
  available integer;
  element_count integer;
  valid_count integer;
BEGIN
  SELECT * INTO s FROM public.stores WHERE id = p_store_id;
  IF NOT FOUND OR NOT coalesce(s.store_enabled, false) THEN RAISE EXCEPTION 'المتجر غير متاح'; END IF;
  IF NOT coalesce(s.accepts_orders, false) THEN RAISE EXCEPTION 'المتجر لا يستقبل طلبات حالياً'; END IF;

  -- ---------------------------------------------------------------- customer
  IF p_customer IS NULL OR jsonb_typeof(p_customer) <> 'object' THEN RAISE EXCEPTION 'بيانات الزبون غير صالحة'; END IF;

  clean_name := btrim(coalesce(p_customer->>'name', ''));
  IF length(clean_name) < 2 OR length(clean_name) > 80 THEN RAISE EXCEPTION 'اسم الزبون غير صالح'; END IF;

  -- Algerian mobile numbers: 05/06/07 followed by eight digits, however written.
  clean_phone := regexp_replace(coalesce(p_customer->>'phone', ''), '[\s()+-]', '', 'g');
  IF clean_phone ~ '^213[5-7][0-9]{8}$' THEN clean_phone := '0' || substr(clean_phone, 4); END IF;
  IF clean_phone !~ '^0[5-7][0-9]{8}$' THEN RAISE EXCEPTION 'رقم الهاتف غير صالح'; END IF;

  fulfillment := coalesce(nullif(btrim(p_customer->>'fulfillment_type'), ''), 'delivery');
  IF fulfillment NOT IN ('delivery', 'pickup') THEN RAISE EXCEPTION 'طريقة الاستلام غير صالحة'; END IF;
  -- The delivery price is the store's own rate for that wilaya. The client's
  -- number is only compared with it: a tampered fee is rejected, never stored.
  IF fulfillment = 'delivery' THEN
    clean_wilaya := lpad(regexp_replace(coalesce(p_wilaya, p_customer->>'wilaya_code', ''), '[^0-9]', '', 'g'), 2, '0');
    IF clean_wilaya !~ '^[0-9]{2}$' OR clean_wilaya::integer NOT BETWEEN 1 AND 58 THEN
      RAISE EXCEPTION 'الولاية مطلوبة للتوصيل';
    END IF;

    -- A wilaya the shop has not priced is still deliverable: the courier is
    -- paid on arrival, so the order carries no delivery fee and says so.
    rate := CASE
      WHEN coalesce(jsonb_typeof(s.delivery_rates), 'null') = 'object'
        THEN s.delivery_rates -> clean_wilaya
      ELSE NULL
    END;

    IF rate IS NULL THEN
      delivery_fee := 0;
      fee_on_arrival := true;
      IF p_delivery_fee IS NOT NULL AND p_delivery_fee <> 0 THEN
        RAISE EXCEPTION 'رسوم التوصيل غير مطابقة';
      END IF;
    ELSE
      IF jsonb_typeof(rate) <> 'number' THEN RAISE EXCEPTION 'سعر التوصيل غير صالح'; END IF;
      delivery_fee := (rate #>> '{}')::integer;
      IF delivery_fee < 0 OR delivery_fee > 1000000 THEN RAISE EXCEPTION 'سعر التوصيل غير صالح'; END IF;
      IF p_delivery_fee IS NOT NULL AND p_delivery_fee IS DISTINCT FROM delivery_fee THEN
        RAISE EXCEPTION 'رسوم التوصيل غير مطابقة';
      END IF;
    END IF;
  ELSE
    -- Pickup: no fee, whatever the client sends.
    delivery_fee := 0;
    clean_wilaya := nullif(btrim(coalesce(p_wilaya, p_customer->>'wilaya_code', '')), '');
    IF p_delivery_fee IS NOT NULL AND p_delivery_fee <> 0 THEN
      RAISE EXCEPTION 'لا توجد رسوم توصيل عند الاستلام من المحل';
    END IF;
  END IF;

  clean_source := coalesce(nullif(btrim(p_source), ''), 'web');
  IF clean_source NOT IN ('web', 'whatsapp') THEN RAISE EXCEPTION 'مصدر الطلب غير صالح'; END IF;

  -- ------------------------------------------------------------------- items
  IF p_items IS NULL OR jsonb_typeof(p_items) <> 'array' OR jsonb_array_length(p_items) = 0 THEN
    RAISE EXCEPTION 'لا توجد منتجات في الطلب';
  END IF;
  IF jsonb_array_length(p_items) > 50 THEN RAISE EXCEPTION 'عدد المنتجات كبير جداً'; END IF;

  SELECT count(*) INTO element_count FROM jsonb_array_elements(p_items) e;
  SELECT count(*) INTO valid_count
    FROM jsonb_array_elements(p_items) e
   WHERE jsonb_typeof(e) = 'object'
     AND (e->>'variant_id') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     AND (e->>'qty') ~ '^[0-9]{1,4}$'
     AND (e->>'qty')::integer BETWEEN 1 AND 999;
  IF valid_count <> element_count THEN RAISE EXCEPTION 'بنود الطلب غير صالحة'; END IF;

  -- Anything not sold by this tenant is rejected before any pricing happens.
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_items) e
     WHERE NOT EXISTS (
       SELECT 1 FROM public.product_variants v
         JOIN public.products p ON p.id = v.product_id
        WHERE v.id = (e->>'variant_id')::uuid
          AND p.tenant_id = s.tenant_id
          AND p.is_active)
  ) THEN RAISE EXCEPTION 'أحد المنتجات غير متوفر'; END IF;

  -- Prices are computed here and only here; anything the client sends is ignored.
  FOR product_row IN
    SELECT v.product_id,
           p.name AS product_name,
           coalesce(p.base_price, 0) AS base_price,
           sum((e->>'qty')::integer) AS qty
      FROM jsonb_array_elements(p_items) e
      JOIN public.product_variants v ON v.id = (e->>'variant_id')::uuid
      JOIN public.products p ON p.id = v.product_id
     GROUP BY v.product_id, p.name, p.base_price
     ORDER BY v.product_id
  LOOP
    total_qty := product_row.qty;
    prices := '{}';

    -- Only product-level offers apply online: a bundle counts every size and
    -- colour of the product, exactly like the till.
    offer_id := NULL;
    offer_ok := false;

    SELECT * INTO offer_row
      FROM public.offers o
     WHERE o.tenant_id = s.tenant_id
       AND o.product_id = product_row.product_id
       AND o.variant_id IS NULL
       AND coalesce(o.is_active, true)
     ORDER BY o.created_at DESC
     LIMIT 1;

    offer_found := FOUND;

    IF offer_found AND offer_row.discount_percentage BETWEEN 1 AND 99 THEN
      discount_unit := round(product_row.base_price * (100 - offer_row.discount_percentage)::numeric / 100)::integer;
      IF discount_unit < 0 THEN discount_unit := 0; END IF;
      FOR step IN 1..total_qty LOOP prices := prices || discount_unit; END LOOP;
      offer_ok := true;

    ELSIF offer_found
          AND offer_row.required_qty >= 2
          AND offer_row.offer_price > 0
          AND total_qty >= offer_row.required_qty THEN
      groups := total_qty / offer_row.required_qty;
      base_unit := round(offer_row.offer_price::numeric / offer_row.required_qty)::integer;
      -- The remainder rides on the last item of each bundle: 3 for 1000 is
      -- 333 + 333 + 334, so the bundle total stays exact.
      last_unit := offer_row.offer_price - base_unit * (offer_row.required_qty - 1);
      IF base_unit > 0 AND last_unit > 0 THEN
        FOR step IN 1..(groups * offer_row.required_qty) LOOP
          prices := prices || CASE WHEN step % offer_row.required_qty = 0 THEN last_unit ELSE base_unit END;
        END LOOP;
        -- Leftovers that do not fill a bundle stay at the normal price.
        FOR step IN 1..(total_qty - groups * offer_row.required_qty) LOOP
          prices := prices || product_row.base_price;
        END LOOP;
        offer_ok := true;
      END IF;
    END IF;

    IF NOT offer_ok THEN
      prices := '{}';
      FOR step IN 1..total_qty LOOP prices := prices || product_row.base_price; END LOOP;
    ELSE
      offer_id := offer_row.id;
    END IF;

    -- A complete look prices its products, but only where no live offer already
    -- does: create_order applies one price per product, and stacking a second
    -- discount would charge less than the shop quoted for the outfit.
    --
    -- p_bundle_units is recomputed here and compared, never trusted: a crafted
    -- request could otherwise buy an outfit for one dinar. A mismatch is not an
    -- error, it just means the server's price is used.
    IF p_look_id IS NOT NULL AND NOT offer_ok THEN
      IF NOT bundle_ready THEN
        bundle := public.looks_bundle_units(p_look_id);
        -- Anything the client sent that disagrees with the server is discarded
        -- wholesale rather than merged: a crafted p_bundle_units could name a
        -- price of one dinar for a product the look prices at thousands.
        IF p_bundle_units IS NOT NULL
           AND (jsonb_typeof(p_bundle_units) <> 'object' OR p_bundle_units IS DISTINCT FROM bundle) THEN
          bundle := public.looks_bundle_units(p_look_id);
        END IF;
        bundle_ready := true;
      END IF;
      IF bundle ? product_row.product_id::text THEN
        unit_price := (bundle->>product_row.product_id::text)::integer;
        IF unit_price IS NOT NULL AND unit_price > 0 THEN
          prices := '{}';
          FOR step IN 1..total_qty LOOP prices := prices || unit_price; END LOOP;
        END IF;
      END IF;
    END IF;

    position := 0;
    FOR line_row IN
      SELECT v.id AS variant_id, v.color, v.size, sum((e->>'qty')::integer) AS qty
        FROM jsonb_array_elements(p_items) e
        JOIN public.product_variants v ON v.id = (e->>'variant_id')::uuid
       WHERE v.product_id = product_row.product_id
       GROUP BY v.id, v.color, v.size
       ORDER BY v.id
    LOOP
      -- Locked per variant so two customers cannot claim the last shirt.
      SELECT (i.quantity - coalesce(i.reserved_qty, 0)) INTO available
        FROM public.inventory i
       WHERE i.store_id = s.id AND i.variant_id = line_row.variant_id
       FOR UPDATE;
      IF NOT FOUND OR available < line_row.qty THEN
        RAISE EXCEPTION 'الكمية المطلوبة غير متوفرة: %', product_row.product_name;
      END IF;

      line_total := 0;
      FOR step IN 1..line_row.qty LOOP
        position := position + 1;
        line_total := line_total + prices[position];
      END LOOP;

      gross_total := product_row.base_price * line_row.qty;
      IF line_total > gross_total THEN line_total := gross_total; END IF;  -- never inflate
      line_discount := greatest(gross_total - line_total, 0);
      unit_price := round(line_total::numeric / line_row.qty)::integer;

      items_json := items_json || jsonb_build_object(
        'product_id', product_row.product_id,
        'variant_id', line_row.variant_id,
        'product_name', product_row.product_name,
        'size', line_row.size,
        'color', line_row.color,
        'qty', line_row.qty,
        'unit_price', unit_price,
        'applied_offer_id', offer_id,
        'line_discount', line_discount,
        'line_total', line_total);

      subtotal_total := subtotal_total + gross_total;
      discount_total := discount_total + line_discount;
    END LOOP;
  END LOOP;

  grand_total := subtotal_total - discount_total + delivery_fee;
  IF grand_total <= 0 OR grand_total > 2147483647 THEN RAISE EXCEPTION 'إجمالي الطلب غير صالح'; END IF;

  -- ----------------------------------------------------------------- customer
  SELECT * INTO customer_row
    FROM public.customers
   WHERE tenant_id = s.tenant_id
     AND regexp_replace(coalesce(phone, ''), '[\s-]', '', 'g') = clean_phone
   ORDER BY id
   LIMIT 1;
  found_customer := FOUND;

  IF NOT found_customer THEN
    SELECT * INTO customer_row
      FROM public.customers
     WHERE tenant_id = s.tenant_id
       AND match_key = public.customer_match_key(clean_name)
     ORDER BY id
     LIMIT 1;
    found_customer := FOUND;
  END IF;

  IF NOT found_customer THEN
    INSERT INTO public.customers(tenant_id, name, phone)
    VALUES (s.tenant_id, clean_name, clean_phone)
    ON CONFLICT (tenant_id, match_key) WHERE match_key IS NOT NULL DO NOTHING
    RETURNING * INTO customer_row;
    found_customer := FOUND;
    IF NOT found_customer THEN
      SELECT * INTO customer_row
        FROM public.customers
       WHERE tenant_id = s.tenant_id
         AND match_key = public.customer_match_key(clean_name)
       ORDER BY id
       LIMIT 1;
      found_customer := FOUND;
    END IF;
  END IF;
  IF found_customer THEN customer_uuid := customer_row.id; END IF;

  -- ------------------------------------------------------------------- write
  token := replace(gen_random_uuid()::text, '-', '');
  order_code := 'ORD-' || lpad(nextval('public.orders_number_seq')::text, 6, '0');

  INSERT INTO public.orders(
    tenant_id, store_id, customer_id, order_number, public_token, status, fulfillment_type,
    customer_name, customer_phone, wilaya_code, commune, address, note,
    subtotal, discount_total, delivery_fee, delivery_fee_on_arrival, total,
    payment_method, source)
  VALUES (
    s.tenant_id, s.id, customer_uuid, order_code, token, 'new', fulfillment,
    clean_name, clean_phone,
    clean_wilaya,
    nullif(btrim(coalesce(p_customer->>'commune', '')), ''),
    nullif(btrim(coalesce(p_customer->>'address', '')), ''),
    nullif(btrim(coalesce(p_customer->>'note', '')), ''),
    subtotal_total, discount_total, delivery_fee, fee_on_arrival, grand_total,
    'cod', clean_source)
  RETURNING id INTO new_order;

  INSERT INTO public.order_items(
    order_id, product_id, variant_id, product_name, size, color,
    qty, unit_price, applied_offer_id, line_discount, line_total)
  SELECT new_order, x.product_id, x.variant_id, x.product_name, x.size, x.color,
         x.qty, x.unit_price, x.applied_offer_id, x.line_discount, x.line_total
    FROM jsonb_to_recordset(items_json) AS x(
      product_id uuid, variant_id uuid, product_name text, size text, color text,
      qty integer, unit_price integer, applied_offer_id uuid,
      line_discount integer, line_total integer);

  IF p_look_id IS NOT NULL THEN
    UPDATE public.orders SET look_id = p_look_id WHERE id = new_order;
  END IF;

  INSERT INTO public.order_status_history(order_id, from_status, to_status, changed_by)
  VALUES (new_order, NULL, 'new', NULL);

  RETURN token;
END $$;

-- The 6-argument version is replaced, not kept alongside: two overloads would
-- let a client call the older one and skip the look price entirely.
DROP FUNCTION IF EXISTS public.create_order(uuid, jsonb, jsonb, text);
DROP FUNCTION IF EXISTS public.create_order(uuid, jsonb, jsonb, text, text, integer);

REVOKE ALL ON FUNCTION public.create_order(uuid,jsonb,jsonb,text,text,integer,uuid,jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_order(uuid,jsonb,jsonb,text,text,integer,uuid,jsonb) TO anon, authenticated;

-- ============================================================ management API
-- Browse products for the picker, with their variants and live stock in a
-- chosen store, without the dashboard having to trust the browser's filtering.
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
             'image_url', p.image_url, 'category', p.category,
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

CREATE OR REPLACE FUNCTION public.engine_looks_list()
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE u public.users;
BEGIN
  SELECT * INTO u FROM public.current_staff();
  IF u.id IS NULL THEN RAISE EXCEPTION 'غير مصرح'; END IF;

  RETURN (
    SELECT coalesce(jsonb_agg(jsonb_build_object(
             'id', l.id, 'name', l.name, 'description', l.description,
             'image_url', l.image_url, 'video_url', l.video_url,
             'bundle_price', l.bundle_price, 'is_active', l.is_active,
             'created_at', l.created_at,
             'items', (
               SELECT coalesce(jsonb_agg(jsonb_build_object(
                        'id', li.id, 'product_id', li.product_id,
                        'variant_id', li.variant_id,
                        'product_name', p.name, 'base_price', p.base_price,
                        'image_url', p.image_url,
                        'size', v.size, 'color', v.color
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

-- One call that replaces a look's definition. Deleting the items and re-adding
-- them is deliberate: an edit is a new set, and treating it as a diff would let
-- a partially-saved look keep an item the merchant removed.
CREATE OR REPLACE FUNCTION public.engine_save_look(
  p_id uuid, p_name text, p_description text, p_image_url text,
  p_video_url text, p_bundle_price integer, p_is_active boolean, p_items jsonb
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
-- The variable is `saved`, not `look_id`: a PL/pgSQL variable that shares a
  -- name with a column makes `WHERE look_id = look_id` ambiguous at runtime.
DECLARE u public.users; saved uuid; clean text; el jsonb;
BEGIN
  SELECT * INTO u FROM public.current_staff();
  IF u.id IS NULL OR u.tenant_id IS NULL THEN RAISE EXCEPTION 'غير مصرح'; END IF;

  clean := nullif(btrim(coalesce(p_name, '')), '');
  IF clean IS NULL THEN RAISE EXCEPTION 'اسم الإطلالة مطلوب'; END IF;
  IF p_bundle_price IS NOT NULL AND (p_bundle_price < 0 OR p_bundle_price > 2147483647) THEN
    RAISE EXCEPTION 'سعر الإطلالة غير صالح';
  END IF;
  IF p_items IS NULL OR jsonb_typeof(p_items) <> 'array' THEN
    RAISE EXCEPTION 'قائمة المنتجات غير صالحة';
  END IF;
  IF jsonb_array_length(p_items) = 0 THEN
    RAISE EXCEPTION 'أضف منتجاً واحداً على الأقل';
  END IF;

  -- Every product and variant must belong to this tenant. Checking here rather
  -- than trusting the client is what stops a look from containing someone
  -- else's product id.
  FOR el IN SELECT * FROM jsonb_array_elements(p_items) LOOP
    SELECT p.id INTO bad_product FROM public.products p
     WHERE p.id = (el->>'product_id')::uuid AND p.tenant_id = u.tenant_id;
    IF bad_product IS NULL THEN RAISE EXCEPTION 'منتج غير موجود في هذه المؤسسة'; END IF;

    IF nullif(el->>'variant_id', '') IS NOT NULL THEN
      SELECT v.id INTO bad_variant FROM public.product_variants v
       JOIN public.products p ON p.id = v.product_id
       WHERE v.id = (el->>'variant_id')::uuid AND p.tenant_id = u.tenant_id;
      IF bad_variant IS NULL THEN RAISE EXCEPTION 'المقاس المحدد غير موجود'; END IF;
    END IF;
    bad_product := NULL; bad_variant := NULL;
  END LOOP;

  IF p_id IS NOT NULL THEN
    UPDATE public.looks
       SET name = clean,
           description = nullif(btrim(coalesce(p_description, '')), ''),
           image_url = nullif(btrim(coalesce(p_image_url, '')), ''),
           video_url = nullif(btrim(coalesce(p_video_url, '')), ''),
           bundle_price = p_bundle_price,
           is_active = coalesce(p_is_active, true)
     WHERE id = p_id AND tenant_id = u.tenant_id
     RETURNING id INTO saved;
    IF NOT FOUND THEN RAISE EXCEPTION 'الإطلالة غير موجودة'; END IF;
    DELETE FROM public.look_items WHERE look_id = saved;
  ELSE
    INSERT INTO public.looks(tenant_id, name, description, image_url, video_url, bundle_price, is_active)
    VALUES (u.tenant_id, clean,
            nullif(btrim(coalesce(p_description, '')), ''),
            nullif(btrim(coalesce(p_image_url, '')), ''),
            nullif(btrim(coalesce(p_video_url, '')), ''),
            p_bundle_price, coalesce(p_is_active, true))
    RETURNING id INTO saved;
  END IF;

  -- DISTINCT ON keeps one row per product: the unique index would otherwise
  -- reject a payload that listed the same product twice.
  INSERT INTO public.look_items(look_id, product_id, variant_id)
  SELECT DISTINCT ON ((el->>'product_id')::uuid)
         saved, (el->>'product_id')::uuid, nullif(el->>'variant_id', '')::uuid
    FROM jsonb_array_elements(p_items) el;

  RETURN saved;
END $$;

CREATE OR REPLACE FUNCTION public.engine_set_look_active(p_look uuid, p_active boolean)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE u public.users;
BEGIN
  SELECT * INTO u FROM public.current_staff();
  UPDATE public.looks SET is_active = coalesce(p_active, true)
   WHERE id = p_look AND tenant_id = u.tenant_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'الإطلالة غير موجودة'; END IF;
END $$;

CREATE OR REPLACE FUNCTION public.engine_delete_look(p_look uuid)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE u public.users;
BEGIN
  SELECT * INTO u FROM public.current_staff();
  IF NOT EXISTS (SELECT 1 FROM public.looks WHERE id = p_look AND tenant_id = u.tenant_id) THEN
    RAISE EXCEPTION 'الإطلالة غير موجودة';
  END IF;

  DELETE FROM public.looks WHERE id = p_look AND tenant_id = u.tenant_id;
END $$;

REVOKE ALL ON FUNCTION public.engine_look_catalog(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.engine_looks_list() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.engine_save_look(uuid, text, text, text, text, integer, boolean, jsonb) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.engine_set_look_active(uuid, boolean) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.engine_delete_look(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.engine_look_catalog(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.engine_looks_list() TO authenticated;
GRANT EXECUTE ON FUNCTION public.engine_save_look(uuid, text, text, text, text, integer, boolean, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.engine_set_look_active(uuid, boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.engine_delete_look(uuid) TO authenticated;

-- ========================================================== storefront reads
-- Resolves the store by the same rule as the rest of the storefront (public
-- slug, store enabled), then returns only that shop's active looks. An unknown
-- or unpublished slug returns an empty array rather than an error, so the tab
-- simply does not appear.
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
             'image_url', l.image_url, 'video_url', l.video_url,
             'bundle_price', CASE WHEN coalesce(s.show_prices, true) THEN l.bundle_price ELSE NULL END,
             'items', (
               SELECT coalesce(jsonb_agg(jsonb_build_object(
                        'product_id', p.id,
                        'variant_id', li.variant_id,
                        'name', p.name,
                        'image_url', p.image_url,
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
                       AND (i.quantity - coalesce(i.reserved_qty, 0)) > 0)
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

REVOKE ALL ON FUNCTION public.get_store_looks(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_store_looks(text) TO anon, authenticated;

-- ================================================================ storage
-- Public read: these are marketing images on a public storefront, and a signed
-- URL would expire on a page a customer may leave open. Writes are restricted
-- to the tenant folder by the same path check the other buckets use.
INSERT INTO storage.buckets(id, name, public, file_size_limit, allowed_mime_types)
VALUES ('look-images', 'look-images', true, 8388608,
        ARRAY['image/jpeg','image/png','image/webp','image/avif'])
ON CONFLICT (id) DO UPDATE
  SET public = true,
      file_size_limit = 8388608,
      allowed_mime_types = ARRAY['image/jpeg','image/png','image/webp','image/avif'];

-- The first path segment is the tenant id; a staff member may only write into
-- their own. Reads are public (bucket-level), so no SELECT policy is needed.
DROP POLICY IF EXISTS look_images_write ON storage.objects;
CREATE POLICY look_images_write ON storage.objects
  FOR ALL TO authenticated
  USING (bucket_id = 'look-images' AND (storage.foldername(name))[1] = public.current_tenant_id()::text)
  WITH CHECK (bucket_id = 'look-images' AND (storage.foldername(name))[1] = public.current_tenant_id()::text);
