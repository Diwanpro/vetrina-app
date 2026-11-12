-- Phase A of the online store: schema, RLS and RPCs only.
--
-- Nothing here is reachable from the public internet except four functions
-- (anon gets EXECUTE on three of them). The tables themselves stay closed:
-- RLS on, no policy for anon, and INSERT/UPDATE/DELETE revoked from every
-- client role, so an order can only be written through create_order() and only
-- read by its own tenant.
--
-- Naming follows the app: tenant_id (never owner_id), store_id (never
-- branch_id), table `stores` (never branches).
--
-- Apply after 202611120004. Idempotent: every object is created with IF NOT
-- EXISTS or CREATE OR REPLACE.

-- ------------------------------------------------------------ storefront flags
ALTER TABLE public.stores ADD COLUMN IF NOT EXISTS slug text;
ALTER TABLE public.stores ADD COLUMN IF NOT EXISTS store_enabled boolean DEFAULT false;
ALTER TABLE public.stores ADD COLUMN IF NOT EXISTS accepts_orders boolean DEFAULT false;
ALTER TABLE public.stores ADD COLUMN IF NOT EXISTS show_prices boolean DEFAULT true;
ALTER TABLE public.stores ADD COLUMN IF NOT EXISTS hide_products_without_image boolean DEFAULT true;

-- Existing rows must behave like the defaults, not like NULL.
UPDATE public.stores SET store_enabled = false WHERE store_enabled IS NULL;
UPDATE public.stores SET accepts_orders = false WHERE accepts_orders IS NULL;
UPDATE public.stores SET show_prices = true WHERE show_prices IS NULL;
UPDATE public.stores SET hide_products_without_image = true WHERE hide_products_without_image IS NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'stores_slug_format') THEN
    ALTER TABLE public.stores ADD CONSTRAINT stores_slug_format
      CHECK (slug IS NULL OR slug ~ '^[a-z0-9]([a-z0-9-]{1,61}[a-z0-9])$');
  END IF;
END $$;

-- Case-insensitive uniqueness: /store/Ali and /store/ali are the same shop.
CREATE UNIQUE INDEX IF NOT EXISTS stores_slug_key
  ON public.stores (lower(slug)) WHERE slug IS NOT NULL;

-- ----------------------------------------------------------- stock reservation
ALTER TABLE public.inventory ADD COLUMN IF NOT EXISTS reserved_qty integer DEFAULT 0;
UPDATE public.inventory SET reserved_qty = 0 WHERE reserved_qty IS NULL;
ALTER TABLE public.inventory ALTER COLUMN reserved_qty SET DEFAULT 0;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'inventory_reserved_qty_check') THEN
    ALTER TABLE public.inventory ADD CONSTRAINT inventory_reserved_qty_check
      CHECK (reserved_qty >= 0);
  END IF;
END $$;

-- --------------------------------------------------------------- orders
CREATE SEQUENCE IF NOT EXISTS public.orders_number_seq START 1000;

CREATE TABLE IF NOT EXISTS public.orders (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  store_id            uuid NOT NULL REFERENCES public.stores(id) ON DELETE CASCADE,
  customer_id         uuid REFERENCES public.customers(id) ON DELETE SET NULL,
  order_number        text NOT NULL,
  -- 32 hex characters: long enough to be unguessable, short enough to paste.
  public_token        text NOT NULL DEFAULT replace(gen_random_uuid()::text, '-', ''),
  status              text NOT NULL DEFAULT 'new',
  fulfillment_type    text NOT NULL DEFAULT 'delivery',
  customer_name       text NOT NULL,
  customer_phone      text NOT NULL,
  wilaya_code         text,
  commune             text,
  address             text,
  note                text,
  subtotal            integer NOT NULL DEFAULT 0,
  discount_total      integer NOT NULL DEFAULT 0,
  delivery_fee        integer NOT NULL DEFAULT 0,
  total               integer NOT NULL DEFAULT 0,
  payment_method      text NOT NULL DEFAULT 'cod',
  source              text NOT NULL DEFAULT 'web',
  rejected_reason     text,
  sale_id             uuid REFERENCES public.sales(id) ON DELETE SET NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  confirmed_at        timestamptz,
  delivered_at        timestamptz
);

-- Convergence for a table that may already exist from an interrupted run.
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS tenant_id uuid;
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS store_id uuid;
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS customer_id uuid;
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS order_number text;
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS public_token text;
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS status text;
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS fulfillment_type text;
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS customer_name text;
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS customer_phone text;
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS wilaya_code text;
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS commune text;
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS address text;
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS note text;
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS subtotal integer;
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS discount_total integer;
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS delivery_fee integer;
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS total integer;
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS payment_method text;
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS source text;
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS rejected_reason text;
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS sale_id uuid;
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS created_at timestamptz;
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS confirmed_at timestamptz;
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS delivered_at timestamptz;

ALTER TABLE public.orders ALTER COLUMN status SET DEFAULT 'new';
ALTER TABLE public.orders ALTER COLUMN fulfillment_type SET DEFAULT 'delivery';
ALTER TABLE public.orders ALTER COLUMN delivery_fee SET DEFAULT 0;
ALTER TABLE public.orders ALTER COLUMN discount_total SET DEFAULT 0;
ALTER TABLE public.orders ALTER COLUMN payment_method SET DEFAULT 'cod';
ALTER TABLE public.orders ALTER COLUMN source SET DEFAULT 'web';
ALTER TABLE public.orders ALTER COLUMN created_at SET DEFAULT now();
ALTER TABLE public.orders ALTER COLUMN public_token SET DEFAULT replace(gen_random_uuid()::text, '-', '');

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'orders_status_check') THEN
    ALTER TABLE public.orders ADD CONSTRAINT orders_status_check
      CHECK (status IN ('new','confirmed','preparing','delivered','rejected','cancelled'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'orders_fulfillment_check') THEN
    ALTER TABLE public.orders ADD CONSTRAINT orders_fulfillment_check
      CHECK (fulfillment_type IN ('delivery','pickup'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'orders_payment_check') THEN
    ALTER TABLE public.orders ADD CONSTRAINT orders_payment_check
      CHECK (payment_method IN ('cod'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'orders_source_check') THEN
    ALTER TABLE public.orders ADD CONSTRAINT orders_source_check
      CHECK (source IN ('web','whatsapp'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'orders_amounts_check') THEN
    ALTER TABLE public.orders ADD CONSTRAINT orders_amounts_check
      CHECK (subtotal >= 0 AND discount_total >= 0 AND delivery_fee >= 0 AND total >= 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'orders_token_check') THEN
    ALTER TABLE public.orders ADD CONSTRAINT orders_token_check
      CHECK (length(public_token) >= 16);
  END IF;
END $$;

-- --------------------------------------------------------------- order items
CREATE TABLE IF NOT EXISTS public.order_items (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id         uuid NOT NULL REFERENCES public.orders(id) ON DELETE CASCADE,
  product_id       uuid REFERENCES public.products(id) ON DELETE SET NULL,
  variant_id       uuid REFERENCES public.product_variants(id) ON DELETE SET NULL,
  product_name     text NOT NULL,
  size             text,
  color            text,
  qty              integer NOT NULL,
  unit_price       integer NOT NULL,
  applied_offer_id uuid REFERENCES public.offers(id) ON DELETE SET NULL,
  line_discount    integer NOT NULL DEFAULT 0,
  line_total       integer NOT NULL
);

ALTER TABLE public.order_items ADD COLUMN IF NOT EXISTS order_id uuid;
ALTER TABLE public.order_items ADD COLUMN IF NOT EXISTS product_id uuid;
ALTER TABLE public.order_items ADD COLUMN IF NOT EXISTS variant_id uuid;
ALTER TABLE public.order_items ADD COLUMN IF NOT EXISTS product_name text;
ALTER TABLE public.order_items ADD COLUMN IF NOT EXISTS size text;
ALTER TABLE public.order_items ADD COLUMN IF NOT EXISTS color text;
ALTER TABLE public.order_items ADD COLUMN IF NOT EXISTS qty integer;
ALTER TABLE public.order_items ADD COLUMN IF NOT EXISTS unit_price integer;
ALTER TABLE public.order_items ADD COLUMN IF NOT EXISTS applied_offer_id uuid;
ALTER TABLE public.order_items ADD COLUMN IF NOT EXISTS line_discount integer;
ALTER TABLE public.order_items ADD COLUMN IF NOT EXISTS line_total integer;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'order_items_qty_check') THEN
    ALTER TABLE public.order_items ADD CONSTRAINT order_items_qty_check CHECK (qty > 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'order_items_amounts_check') THEN
    ALTER TABLE public.order_items ADD CONSTRAINT order_items_amounts_check
      CHECK (unit_price >= 0 AND line_discount >= 0 AND line_total >= 0);
  END IF;
END $$;

-- ------------------------------------------------------- order status history
CREATE TABLE IF NOT EXISTS public.order_status_history (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id    uuid NOT NULL REFERENCES public.orders(id) ON DELETE CASCADE,
  from_status text,
  to_status   text NOT NULL,
  changed_by  uuid REFERENCES public.users(id) ON DELETE SET NULL,
  changed_at  timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.order_status_history ADD COLUMN IF NOT EXISTS order_id uuid;
ALTER TABLE public.order_status_history ADD COLUMN IF NOT EXISTS from_status text;
ALTER TABLE public.order_status_history ADD COLUMN IF NOT EXISTS to_status text;
ALTER TABLE public.order_status_history ADD COLUMN IF NOT EXISTS changed_by uuid;
ALTER TABLE public.order_status_history ADD COLUMN IF NOT EXISTS changed_at timestamptz;
ALTER TABLE public.order_status_history ALTER COLUMN changed_at SET DEFAULT now();

-- ------------------------------------------------------------------ indexes
CREATE UNIQUE INDEX IF NOT EXISTS orders_public_token_key ON public.orders (public_token);
CREATE UNIQUE INDEX IF NOT EXISTS orders_tenant_number_key ON public.orders (tenant_id, order_number);
CREATE INDEX IF NOT EXISTS orders_store_status ON public.orders (store_id, status);
CREATE INDEX IF NOT EXISTS orders_tenant_created ON public.orders (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS order_items_order ON public.order_items (order_id);
CREATE INDEX IF NOT EXISTS order_items_variant ON public.order_items (variant_id);
CREATE INDEX IF NOT EXISTS order_history_order ON public.order_status_history (order_id, changed_at DESC);

-- --------------------------------------------------------------- RLS and grants
ALTER TABLE public.orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.order_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.order_status_history ENABLE ROW LEVEL SECURITY;

-- No client role may write these tables; every write goes through a function.
REVOKE ALL ON TABLE public.orders, public.order_items, public.order_status_history
  FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.orders, public.order_items, public.order_status_history
  TO authenticated, service_role;
GRANT USAGE, SELECT ON SEQUENCE public.orders_number_seq TO authenticated;

DROP POLICY IF EXISTS orders_tenant_read ON public.orders;
CREATE POLICY orders_tenant_read ON public.orders
  FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.current_staff() u WHERE u.tenant_id = orders.tenant_id));

DROP POLICY IF EXISTS order_items_tenant_read ON public.order_items;
CREATE POLICY order_items_tenant_read ON public.order_items
  FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.orders o
      JOIN public.current_staff() u ON u.tenant_id = o.tenant_id
     WHERE o.id = order_items.order_id));

DROP POLICY IF EXISTS order_history_tenant_read ON public.order_status_history;
CREATE POLICY order_history_tenant_read ON public.order_status_history
  FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.orders o
      JOIN public.current_staff() u ON u.tenant_id = o.tenant_id
     WHERE o.id = order_status_history.order_id));

-- =========================================================== public storefront
-- These three run as the owner, so they read tables the browser can never see,
-- and they return hand-built jsonb rather than rows: no cost, no min_price and
-- no other customer's data can leak through them.

CREATE OR REPLACE FUNCTION public.get_store_by_slug(p_slug text)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE s public.stores;
BEGIN
  IF nullif(btrim(coalesce(p_slug,'')),'') IS NULL THEN RETURN NULL; END IF;

  SELECT * INTO s
    FROM public.stores
   WHERE lower(slug) = lower(btrim(p_slug))
     AND coalesce(store_enabled, false)
   LIMIT 1;
  IF NOT FOUND THEN RETURN NULL; END IF;

  RETURN jsonb_build_object(
    'store_id', s.id,
    'tenant_id', s.tenant_id,
    'name', s.name,
    'logo_url', s.logo_url,
    'phone', s.phone,
    'address', s.address,
    'google_maps_url', s.google_maps_url,
    'show_prices', coalesce(s.show_prices, true),
    'accepts_orders', coalesce(s.accepts_orders, false),
    'hide_products_without_image', coalesce(s.hide_products_without_image, true)
  );
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

-- ------------------------------------------------------------------ create_order
CREATE OR REPLACE FUNCTION public.create_order(
  p_store_id uuid,
  p_customer jsonb,
  p_items jsonb,
  p_source text
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
  grand_total integer := 0;
  fulfillment text;
  clean_phone text;
  clean_name text;
  clean_source text;
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
  IF fulfillment = 'delivery' AND nullif(btrim(coalesce(p_customer->>'wilaya_code', '')), '') IS NULL THEN
    RAISE EXCEPTION 'الولاية مطلوبة للتوصيل';
  END IF;

  IF fulfillment = 'delivery' AND nullif(btrim(coalesce(p_customer->>'delivery_fee', '')), '') IS NOT NULL THEN
    IF (p_customer->>'delivery_fee') !~ '^[0-9]{1,6}$' THEN RAISE EXCEPTION 'رسوم التوصيل غير صالحة'; END IF;
    delivery_fee := (p_customer->>'delivery_fee')::integer;
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
    subtotal, discount_total, delivery_fee, total, payment_method, source)
  VALUES (
    s.tenant_id, s.id, customer_uuid, order_code, token, 'new', fulfillment,
    clean_name, clean_phone,
    nullif(btrim(coalesce(p_customer->>'wilaya_code', '')), ''),
    nullif(btrim(coalesce(p_customer->>'commune', '')), ''),
    nullif(btrim(coalesce(p_customer->>'address', '')), ''),
    nullif(btrim(coalesce(p_customer->>'note', '')), ''),
    subtotal_total, discount_total, delivery_fee, grand_total, 'cod', clean_source)
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

-- ------------------------------------------------------------ order tracking
CREATE OR REPLACE FUNCTION public.get_order_by_token(p_token text)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE o public.orders; result jsonb;
BEGIN
  IF nullif(btrim(coalesce(p_token, '')), '') IS NULL THEN RETURN NULL; END IF;

  SELECT * INTO o FROM public.orders WHERE public_token = btrim(p_token);
  IF NOT FOUND THEN RETURN NULL; END IF;

  RETURN jsonb_build_object(
    'order_number', o.order_number,
    'status', o.status,
    'fulfillment_type', o.fulfillment_type,
    'customer_name', o.customer_name,
    -- Enough to recognise your own number, not enough to harvest it.
    'customer_phone', left(o.customer_phone, 2) || repeat('*', greatest(length(o.customer_phone) - 4, 0))
                      || right(o.customer_phone, 2),
    'wilaya_code', o.wilaya_code,
    'commune', o.commune,
    'subtotal', o.subtotal,
    'discount_total', o.discount_total,
    'delivery_fee', o.delivery_fee,
    'total', o.total,
    'payment_method', o.payment_method,
    'rejected_reason', o.rejected_reason,
    'created_at', o.created_at,
    'confirmed_at', o.confirmed_at,
    'delivered_at', o.delivered_at,
    'store_name', (SELECT s.name FROM public.stores s WHERE s.id = o.store_id),
    'store_phone', (SELECT s.phone FROM public.stores s WHERE s.id = o.store_id),
    'items', (
      SELECT coalesce(jsonb_agg(jsonb_build_object(
               'product_name', i.product_name,
               'size', i.size,
               'color', i.color,
               'qty', i.qty,
               'unit_price', i.unit_price,
               'line_discount', i.line_discount,
               'line_total', i.line_total) ORDER BY i.id), '[]'::jsonb)
        FROM public.order_items i WHERE i.order_id = o.id),
    'history', (
      SELECT coalesce(jsonb_agg(jsonb_build_object(
               'status', h.to_status,
               'at', h.changed_at) ORDER BY h.changed_at, h.id), '[]'::jsonb)
        FROM public.order_status_history h WHERE h.order_id = o.id)
  );
END $$;

-- --------------------------------------------------------- staff: move an order
CREATE OR REPLACE FUNCTION public.update_order_status(
  p_order_id uuid,
  p_new_status text,
  p_reason text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  o public.orders;
  u public.users;
  line record;
  old_status text;
  was_reserved boolean;
  available_qty integer;
  created_sale uuid;
  sale_lines jsonb;
BEGIN
  SELECT * INTO o FROM public.orders WHERE id = p_order_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'الطلب غير موجود'; END IF;

  SELECT * INTO u FROM public.current_staff();
  IF u.id IS NULL OR u.tenant_id IS DISTINCT FROM o.tenant_id THEN RAISE EXCEPTION 'غير مصرح'; END IF;
  IF u.role NOT IN ('owner', 'manager') AND u.store_id IS DISTINCT FROM o.store_id THEN
    RAISE EXCEPTION 'غير مصرح لهذا الفرع';
  END IF;

  IF p_new_status NOT IN ('new', 'confirmed', 'preparing', 'delivered', 'rejected', 'cancelled') THEN
    RAISE EXCEPTION 'حالة غير صالحة';
  END IF;

  old_status := o.status;
  IF old_status = p_new_status THEN
    RETURN jsonb_build_object('status', old_status, 'sale_id', o.sale_id);
  END IF;

  -- Delivered is final, and an order cannot jump straight from new to delivered.
  IF NOT (
       (old_status = 'new'       AND p_new_status IN ('confirmed', 'rejected', 'cancelled'))
    OR (old_status = 'confirmed' AND p_new_status IN ('preparing', 'delivered', 'rejected', 'cancelled'))
    OR (old_status = 'preparing' AND p_new_status IN ('delivered', 'rejected', 'cancelled'))
  ) THEN
    RAISE EXCEPTION 'انتقال غير مسموح من % إلى %', old_status, p_new_status;
  END IF;

  was_reserved := old_status IN ('confirmed', 'preparing');

  -- Confirm: hold the stock without taking it out of the shop's count, so the
  -- shop can still sell it in person until the order ships.
  IF p_new_status = 'confirmed' THEN
    FOR line IN
      SELECT variant_id, sum(qty)::integer AS qty
        FROM public.order_items WHERE order_id = o.id GROUP BY variant_id
    LOOP
      SELECT quantity - coalesce(reserved_qty, 0) INTO available_qty
        FROM public.inventory
       WHERE store_id = o.store_id AND variant_id = line.variant_id
       FOR UPDATE;
      IF NOT FOUND THEN RAISE EXCEPTION 'المخزون غير معرّف لأحد المنتجات'; END IF;
      IF available_qty < line.qty THEN
        RAISE EXCEPTION 'المخزون غير كافٍ لتأكيد الطلب';
      END IF;
      UPDATE public.inventory
         SET reserved_qty = coalesce(reserved_qty, 0) + line.qty
       WHERE store_id = o.store_id AND variant_id = line.variant_id;
    END LOOP;
  END IF;

  -- Leaving the reserved states: give the hold back.
  IF was_reserved AND p_new_status IN ('rejected', 'cancelled', 'delivered') THEN
    FOR line IN
      SELECT variant_id, sum(qty)::integer AS qty
        FROM public.order_items WHERE order_id = o.id GROUP BY variant_id
    LOOP
      UPDATE public.inventory
         SET reserved_qty = greatest(coalesce(reserved_qty, 0) - line.qty, 0)
       WHERE store_id = o.store_id AND variant_id = line.variant_id;
    END LOOP;
  END IF;

  -- Delivered: the goods leave the shop, so the existing sale engine writes the
  -- sale and deducts the stock. It is the same code path as the till, which
  -- means profit, low stock and the sales log all stay consistent.
  IF p_new_status = 'delivered' THEN
    SELECT coalesce(jsonb_agg(jsonb_build_object(
             'variant_id', t.variant_id,
             'quantity', t.qty,
             'final_price', t.unit_price,
             'original_price', t.original_price,
             'subtotal', t.line_total,
             'offer_id', t.applied_offer_id) ORDER BY t.variant_id), '[]'::jsonb)
      INTO sale_lines
      FROM (
        SELECT variant_id,
               sum(qty)::integer AS qty,
               round(sum(line_total)::numeric / sum(qty))::integer AS unit_price,
               round((sum(line_total) + sum(line_discount))::numeric / sum(qty))::integer AS original_price,
               sum(line_total)::integer AS line_total,
               max(applied_offer_id::text)::uuid AS applied_offer_id
          FROM public.order_items
         WHERE order_id = o.id
         GROUP BY variant_id
      ) t;

    created_sale := public.engine_sync_sale(
      o.store_id, o.tenant_id, 'order-' || o.id::text, sale_lines, 'cash',
      coalesce(o.created_at, now()), NULL);

    UPDATE public.orders SET sale_id = created_sale WHERE id = o.id;
  END IF;

  UPDATE public.orders
     SET status = p_new_status,
         confirmed_at = CASE WHEN p_new_status = 'confirmed' THEN coalesce(confirmed_at, now()) ELSE confirmed_at END,
         delivered_at = CASE WHEN p_new_status = 'delivered' THEN coalesce(delivered_at, now()) ELSE delivered_at END,
         rejected_reason = CASE WHEN p_new_status = 'rejected'
                                THEN nullif(btrim(coalesce(p_reason, '')), '')
                                ELSE rejected_reason END
   WHERE id = o.id;

  INSERT INTO public.order_status_history(order_id, from_status, to_status, changed_by)
  VALUES (o.id, old_status, p_new_status, u.id);

  RETURN jsonb_build_object(
    'status', p_new_status,
    'sale_id', (SELECT sale_id FROM public.orders WHERE id = o.id));
END $$;

-- ------------------------------------------------------- grants for the functions
REVOKE ALL ON FUNCTION public.get_store_by_slug(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.get_store_products(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.create_order(uuid,jsonb,jsonb,text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.get_order_by_token(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.update_order_status(uuid,text,text) FROM PUBLIC, anon, authenticated;

-- The public storefront: anonymous, read-only, and only these four.
GRANT EXECUTE ON FUNCTION public.get_store_by_slug(text) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_store_products(uuid) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_order(uuid,jsonb,jsonb,text) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_order_by_token(text) TO anon, authenticated;

-- Staff only: moving an order touches stock and writes a sale.
GRANT EXECUTE ON FUNCTION public.update_order_status(uuid,text,text) TO authenticated;

-- ---------------------------------------------------------------------------
-- engine_sync_sale: product-level offers unlock the floor
--
-- 202611120004 made offers per product (variant_id NULL). The floor bypass
-- still matched o.variant_id = item.variant_id, so any discounted line coming
-- from a product-level offer was rejected when it landed under min_price —
-- which is exactly what a delivered online order does. Only the offer match
-- changed; the rest is the current definition.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.engine_sync_sale(
  p_store uuid, p_tenant uuid, p_local_id text, p_items jsonb, p_payment text,
  p_created_at timestamptz, p_split jsonb DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE
  staff uuid; previous public.sales; result uuid; item record; stock integer;
  floor_price numeric; total numeric; item_product uuid; cash_taken bigint; due bigint; method text;
  customer record; found_customer boolean := false;
  customer_key text; customer_phone text; receipt text;
BEGIN
 staff:=public.engine_validate(p_store,p_tenant,ARRAY['owner','manager','employee']);
 IF nullif(p_local_id,'') IS NULL OR length(p_local_id)>100 OR p_payment IS NULL OR p_payment NOT IN('cash','check','ccp') OR p_created_at IS NULL OR p_created_at>now()+interval '5 minutes' THEN RAISE EXCEPTION 'بيانات الفاتورة غير صالحة'; END IF;
 IF jsonb_typeof(p_items) IS DISTINCT FROM 'array' OR jsonb_array_length(p_items)=0 OR jsonb_array_length(p_items)>200 THEN RAISE EXCEPTION 'بنود الفاتورة غير صالحة'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(p_store::text||p_local_id,0));
 SELECT * INTO previous FROM public.sales WHERE store_id=p_store AND local_id=p_local_id;
 IF FOUND THEN
  IF previous.user_id IS DISTINCT FROM staff OR previous.sync_items IS DISTINCT FROM p_items OR previous.payment_method IS DISTINCT FROM p_payment THEN RAISE EXCEPTION 'معرّف محلي مكرر ببيانات مختلفة'; END IF;
  RETURN previous.id;
 END IF;
 IF EXISTS(SELECT 1 FROM jsonb_to_recordset(p_items) AS x(variant_id uuid,quantity numeric,final_price numeric,original_price numeric) WHERE variant_id IS NULL OR quantity IS NULL OR quantity<=0 OR quantity<>trunc(quantity) OR quantity>2147483647 OR final_price IS NULL OR final_price<0 OR final_price<>trunc(final_price) OR final_price>2147483647 OR original_price IS NULL OR original_price<0 OR original_price<>trunc(original_price) OR original_price>2147483647) THEN RAISE EXCEPTION 'كميات أو أسعار غير صالحة'; END IF;
 IF (SELECT count(*) FROM jsonb_to_recordset(p_items) AS x(variant_id uuid))<>(SELECT count(DISTINCT variant_id) FROM jsonb_to_recordset(p_items) AS x(variant_id uuid)) THEN RAISE EXCEPTION 'مقاس مكرر'; END IF;
 SELECT sum(coalesce(subtotal,quantity*final_price)) INTO total FROM jsonb_to_recordset(p_items) AS x(quantity numeric,final_price numeric,subtotal numeric);
 IF total>2147483647 THEN RAISE EXCEPTION 'إجمالي كبير جداً'; END IF;

 IF p_split IS NULL OR p_split = 'null'::jsonb THEN
   cash_taken := CASE WHEN p_payment='cash' THEN total::bigint ELSE 0 END;
   due := 0; method := NULL;
 ELSE
   BEGIN
     cash_taken := (p_split->>'cash')::bigint;
     due := (p_split->>'amount')::bigint;
     method := nullif(p_split->>'method','');
     customer_key := nullif(trim(p_split->>'customer_name'),'');
     customer_phone := nullif(regexp_replace(trim(coalesce(p_split->>'customer_phone','')), '[\s-]', '', 'g'), '');
     receipt := nullif(trim(p_split->>'receipt_url'),'');
   EXCEPTION WHEN others THEN RAISE EXCEPTION 'بيانات الدفع المختلط غير صالحة'; END;
   IF cash_taken IS NULL OR due IS NULL OR cash_taken < 0 OR due <= 0 THEN RAISE EXCEPTION 'بيانات الدفع المختلط غير صالحة'; END IF;
   IF cash_taken + due <> total::bigint THEN RAISE EXCEPTION 'المدفوع نقداً والمتبقي لا يساويان إجمالي الفاتورة'; END IF;
   IF method IS NULL OR method NOT IN ('credit','check','ccp') THEN RAISE EXCEPTION 'طريقة تسديد المتبقي غير صالحة'; END IF;
   IF method IN ('check','ccp') AND receipt IS NULL THEN RAISE EXCEPTION 'أرفق صورة الشيك أو الوصل'; END IF;
   IF method = 'credit' AND customer_key IS NULL THEN RAISE EXCEPTION 'اسم الزبون مطلوب لتسجيل الكريدي'; END IF;
 END IF;

 INSERT INTO public.sales(store_id,user_id,total_amount,payment_method,status,local_id,synced_at,created_at,sync_items,cash_amount)
 VALUES(p_store,staff,total, CASE WHEN method IS NULL THEN p_payment ELSE 'cash' END,'completed',p_local_id,now(),p_created_at,p_items,cash_taken)
 RETURNING id INTO result;

 FOR item IN SELECT * FROM jsonb_to_recordset(p_items) AS x(variant_id uuid,quantity integer,final_price integer,original_price integer,subtotal numeric,offer_id uuid) ORDER BY variant_id LOOP
  SELECT coalesce(v.min_price,0), v.product_id INTO floor_price, item_product FROM public.product_variants v JOIN public.products p ON p.id=v.product_id WHERE v.id=item.variant_id AND p.tenant_id=p_tenant AND p.is_active=true FOR UPDATE OF v;
  IF NOT FOUND THEN RAISE EXCEPTION 'مقاس غير متاح. راجع الفاتورة المحلية'; END IF;
  -- Only an active offer of this tenant, for this very variant, unlocks the floor.
  IF item.final_price<floor_price AND NOT EXISTS(SELECT 1 FROM public.offers o WHERE o.id=item.offer_id AND o.tenant_id=p_tenant AND (o.variant_id=item.variant_id OR (o.variant_id IS NULL AND o.product_id=item_product)) AND coalesce(o.is_active,true)) THEN RAISE EXCEPTION 'سعر أقل من الحد الأدنى بدون عرض ساري. راجع الفاتورة المحلية'; END IF;
  -- A line total may discount, never inflate, and must stay a whole positive amount.
  IF item.subtotal IS NOT NULL AND (item.subtotal<=0 OR item.subtotal<>trunc(item.subtotal) OR item.subtotal>item.quantity*greatest(item.original_price,item.final_price)) THEN RAISE EXCEPTION 'إجمالي بند غير صالح. راجع الفاتورة المحلية'; END IF;
  SELECT quantity INTO stock FROM public.inventory WHERE variant_id=item.variant_id AND store_id=p_store FOR UPDATE;
  IF NOT FOUND OR stock<item.quantity THEN RAISE EXCEPTION 'المخزون غير كافٍ. راجع الفاتورة المحلية'; END IF;
  UPDATE public.inventory SET quantity=quantity-item.quantity,updated_at=now() WHERE variant_id=item.variant_id AND store_id=p_store;
  INSERT INTO public.sale_items(sale_id,variant_id,quantity,original_price,final_price,unit_price,subtotal,offer_id) VALUES(result,item.variant_id,item.quantity,item.original_price,item.final_price,item.final_price,coalesce(item.subtotal,item.final_price::numeric*item.quantity),item.offer_id);
 END LOOP;

 IF method = 'credit' THEN
   -- An id chosen from the autocomplete wins: the cashier already confirmed
   -- which row this is, so there is nothing to match.
   IF nullif(trim(p_split->>'customer_id'),'') IS NOT NULL THEN
     SELECT * INTO customer FROM public.customers
      WHERE id = (p_split->>'customer_id')::uuid AND tenant_id = p_tenant;
     found_customer := FOUND;
   END IF;
   -- Phone first (normalised on both sides), then the case-insensitive name.
   -- `FOUND` is tested after every SELECT INTO and the boolean is used for the
   -- rest: reading a field of a record that was never assigned raises
   -- 55000 "record customer is not assigned yet".
   IF customer_phone IS NOT NULL THEN
     SELECT * INTO customer FROM public.customers
      WHERE tenant_id = p_tenant
        AND regexp_replace(coalesce(phone,''), '[\s-]', '', 'g') = customer_phone
      ORDER BY id LIMIT 1;
     found_customer := FOUND;
   END IF;
   IF NOT found_customer THEN
     SELECT * INTO customer FROM public.customers
      WHERE tenant_id = p_tenant AND match_key = public.customer_match_key(customer_key)
      ORDER BY id LIMIT 1;
     found_customer := FOUND;
   END IF;
   IF NOT found_customer THEN
     -- `ON CONFLICT DO NOTHING` covers the race where two tills create the same
     -- new customer at once: the loser's insert is dropped and the row is then
     -- read back, so both sales land on one customer instead of two.
     INSERT INTO public.customers(tenant_id, name, phone)
     VALUES(p_tenant, customer_key, customer_phone)
     ON CONFLICT (tenant_id, match_key) WHERE match_key IS NOT NULL DO NOTHING
     RETURNING * INTO customer;
     found_customer := FOUND;
     IF NOT found_customer THEN
       SELECT * INTO customer FROM public.customers
        WHERE tenant_id = p_tenant AND match_key = public.customer_match_key(customer_key)
        ORDER BY id LIMIT 1;
       found_customer := FOUND;
     END IF;
   END IF;
   -- A credit sale must never be stored without a customer.
   IF NOT found_customer OR customer.id IS NULL THEN
     RAISE EXCEPTION 'تعذر تحديد الزبون لتسجيل الكريدي';
   END IF;
   INSERT INTO public.credits(store_id, created_by, customer_id, total_amount, remaining_amount, description, status, sale_id)
   VALUES(p_store, staff, customer.id, due, due, 'فاتورة بيع مختلط', 'active', result);
 ELSIF method IN ('check','ccp') THEN
   INSERT INTO public.pending_collections(store_id, customer_name, amount, payment_method, receipt_url, status, sale_id)
   VALUES(p_store, coalesce(customer_key,''), due, method, receipt, 'pending', result);
 END IF;

 RETURN result;
END $$;

REVOKE ALL ON FUNCTION public.engine_sync_sale(uuid,uuid,text,jsonb,text,timestamptz,jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.engine_sync_sale(uuid,uuid,text,jsonb,text,timestamptz,jsonb) TO authenticated;
