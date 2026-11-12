-- Delivery fallback, and sold-out sizes the picker can show.
--
-- 1. A wilaya the shop never priced used to be rejected outright, which left
--    the checkout with no way to order at all. Now the order goes through with
--    delivery_fee = 0 and delivery_fee_on_arrival = true: the courier is paid
--    on arrival, and the shop can see that on the order.
-- 2. get_store_products hid sold-out variants, so the size picker silently
--    showed a different product than the shop actually stocks. It now returns
--    every stocked variant with its availability; the client greys out the
--    zeros. Products with nothing sellable are still not listed.
--
-- Apply after 202611120008. Idempotent.

-- ------------------------------------------------- delivery paid on arrival
ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS delivery_fee_on_arrival boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.orders.delivery_fee_on_arrival IS
  'True when the shop had no rate for the wilaya: the customer pays the courier directly.';

CREATE OR REPLACE FUNCTION public.create_order(
  p_store_id uuid,
  p_customer jsonb,
  p_items jsonb,
  p_source text,
  p_wilaya text,
  p_delivery_fee integer
) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  s public.stores;
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

  INSERT INTO public.order_status_history(order_id, from_status, to_status, changed_by)
  VALUES (new_order, NULL, 'new', NULL);

  RETURN token;
END $$;

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

REVOKE ALL ON FUNCTION public.create_order(uuid,jsonb,jsonb,text,text,integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_order(uuid,jsonb,jsonb,text,text,integer) TO anon, authenticated;

REVOKE ALL ON FUNCTION public.get_store_products(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_store_products(uuid) TO anon, authenticated;
