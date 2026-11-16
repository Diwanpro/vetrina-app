-- P5: mandatory store type, smart catalogue context, order-line image snapshot
-- and retirement of the old mixed demo products.
--
-- Rules kept from the shipping blueprint:
--   * public.orders is NEVER altered/updated/inserted/deleted here;
--   * staff/session RPCs stay SECURITY DEFINER with pinned search_path;
--   * the public storefront learns the store type through get_store_by_slug;
--   * old [seed] rows are hidden, not deleted, so demo sales history survives.

-- ------------------------------------------------------------------ stores
ALTER TABLE public.stores ADD COLUMN IF NOT EXISTS store_type text;
UPDATE public.stores
   SET store_type = 'mens'
 WHERE store_type IS NULL OR store_type NOT IN ('mens', 'womens');
ALTER TABLE public.stores ALTER COLUMN store_type SET DEFAULT 'mens';
ALTER TABLE public.stores ALTER COLUMN store_type SET NOT NULL;
ALTER TABLE public.stores DROP CONSTRAINT IF EXISTS stores_store_type_check;
ALTER TABLE public.stores ADD CONSTRAINT stores_store_type_check
  CHECK (store_type IN ('mens', 'womens'));

-- ------------------------------------------------------- order item pictures
-- The line keeps the picture even if the product is later deleted (FK is
-- ON DELETE SET NULL). A BEFORE INSERT trigger snapshots images[1] or
-- image_url from the product, and existing rows are backfilled once.
ALTER TABLE public.order_items ADD COLUMN IF NOT EXISTS image_url text;

CREATE OR REPLACE FUNCTION public.order_item_image_default()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.image_url IS NULL AND NEW.product_id IS NOT NULL THEN
    NEW.image_url := (
      SELECT coalesce(
        nullif((
          SELECT t.x
            FROM unnest(coalesce(p.images, ARRAY[]::text[])) AS t(x)
           WHERE btrim(coalesce(t.x, '')) <> ''
           LIMIT 1
        ), ''),
        nullif(btrim(coalesce(p.image_url, '')), '')
      )
      FROM public.products p
      WHERE p.id = NEW.product_id
    );
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_order_item_image ON public.order_items;
CREATE TRIGGER trg_order_item_image
BEFORE INSERT ON public.order_items
FOR EACH ROW EXECUTE FUNCTION public.order_item_image_default();

UPDATE public.order_items oi
   SET image_url = src.image_url
  FROM (
    SELECT oi2.id,
           coalesce(
             nullif((
               SELECT t.x
                 FROM unnest(coalesce(p.images, ARRAY[]::text[])) AS t(x)
                WHERE btrim(coalesce(t.x, '')) <> ''
                LIMIT 1
             ), ''),
             nullif(btrim(coalesce(p.image_url, '')), '')
           ) AS image_url
      FROM public.order_items oi2
      JOIN public.products p ON p.id = oi2.product_id
     WHERE oi2.image_url IS NULL
  ) src
 WHERE src.id = oi.id AND src.image_url IS NOT NULL;

REVOKE ALL ON FUNCTION public.order_item_image_default() FROM PUBLIC, anon, authenticated;

-- Hide the old mixed hand-run seed. Deleting them would cascade into variants,
-- inventory and historical sale lines; is_active=false keeps history intact.
UPDATE public.products SET is_active = false WHERE name LIKE '[seed] %';

-- ------------------------------------------------------------- signup RPC
-- Four-argument overload makes «نوع المتجر» mandatory for every new tenant.
-- The old three-argument function is revoked from clients so it cannot bypass
-- the new requirement.
CREATE OR REPLACE FUNCTION public.engine_create_trial_tenant(
  p_store_name text,
  p_owner_name text,
  p_phone text,
  p_store_type text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  me uuid := auth.uid();
  tenant_id uuid;
  store_id uuid;
  staff_id uuid;
  normalized text;
  email_local text;
BEGIN
  IF me IS NULL THEN RAISE EXCEPTION 'يرجى تسجيل الدخول أولاً'; END IF;

  SELECT id INTO staff_id FROM public.users WHERE auth_id = me LIMIT 1;
  IF staff_id IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'هذا الحساب مسجل مسبقاً', 'existing', true);
  END IF;

  IF nullif(btrim(p_store_name), '') IS NULL OR length(btrim(p_store_name)) > 200 THEN
    RAISE EXCEPTION 'اسم المحل مطلوب (حتى 200 حرف)';
  END IF;
  IF nullif(btrim(p_owner_name), '') IS NULL OR length(btrim(p_owner_name)) > 200 THEN
    RAISE EXCEPTION 'اسم المالك مطلوب (حتى 200 حرف)';
  END IF;
  IF p_store_type NOT IN ('mens', 'womens') THEN
    RAISE EXCEPTION 'نوع المتجر مطلوب';
  END IF;

  normalized := regexp_replace(coalesce(p_phone, ''), '[^0-9]', '', 'g');
  IF length(normalized) < 8 OR length(normalized) > 20 THEN
    RAISE EXCEPTION 'رقم الهاتف غير صالح';
  END IF;

  email_local := split_part(coalesce(auth.jwt() ->> 'email', ''), '@', 1);
  IF regexp_replace(email_local, '[^0-9]', '', 'g') <> normalized THEN
    RAISE EXCEPTION 'رقم الهاتف لا يطابق حساب الدخول';
  END IF;

  IF EXISTS (SELECT 1 FROM public.users WHERE username = normalized) THEN
    RAISE EXCEPTION 'رقم الهاتف مستخدم بالفعل';
  END IF;

  INSERT INTO public.tenants(name, phone, is_active, trial_start_date, branches_limit)
  VALUES (btrim(p_store_name), normalized, false, now(), 1)
  RETURNING id INTO tenant_id;

  INSERT INTO public.stores(tenant_id, name, store_type)
  VALUES (tenant_id, btrim(p_store_name), p_store_type)
  RETURNING id INTO store_id;

  INSERT INTO public.users(tenant_id, store_id, username, role, is_active, auth_id, full_name)
  VALUES (tenant_id, store_id, normalized, 'owner', true, me, btrim(p_owner_name))
  RETURNING id INTO staff_id;

  RETURN jsonb_build_object(
    'ok', true,
    'tenant_id', tenant_id,
    'store_id', store_id,
    'staff_id', staff_id,
    'store_type', p_store_type,
    'trial_ends_at', now() + make_interval(days => public.trial_days())
  );
END $$;

REVOKE ALL ON FUNCTION public.engine_create_trial_tenant(text,text,text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.engine_create_trial_tenant(text,text,text,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.engine_create_trial_tenant(text,text,text,text) TO authenticated;

-- -------------------------------------------------------------- branch RPC
-- New branches pick their type explicitly; the old two-argument overload is
-- kept for integration scripts and defaults to the column's 'mens' default.
CREATE OR REPLACE FUNCTION public.engine_add_store(p_name text, p_address text, p_store_type text)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE u public.users; t public.tenants; result uuid;
BEGIN
  SELECT * INTO u FROM public.current_staff();
  IF u.id IS NULL OR u.role <> 'owner' THEN RAISE EXCEPTION 'للمالك فقط'; END IF;
  SELECT * INTO t FROM public.tenants WHERE id = u.tenant_id FOR UPDATE;
  IF t.is_active = false AND t.subscription_end_date < now() THEN RAISE EXCEPTION 'انتهى الاشتراك'; END IF;
  IF (SELECT count(*) FROM public.stores WHERE tenant_id = u.tenant_id) >= coalesce(t.branches_limit, 0) THEN
    RAISE EXCEPTION 'وصلت إلى حد الفروع. يرجى ترقية الاشتراك';
  END IF;
  IF nullif(trim(p_name), '') IS NULL OR length(p_name) > 200 THEN RAISE EXCEPTION 'اسم الفرع غير صالح'; END IF;
  IF p_store_type NOT IN ('mens', 'womens') THEN RAISE EXCEPTION 'نوع المتجر مطلوب'; END IF;
  INSERT INTO public.stores(tenant_id, name, address, store_type)
  VALUES (u.tenant_id, trim(p_name), nullif(trim(p_address), ''), p_store_type)
  RETURNING id INTO result;
  RETURN result;
END $$;

REVOKE ALL ON FUNCTION public.engine_add_store(text,text,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.engine_add_store(text,text,text) TO authenticated;

-- ------------------------------------------------------------ settings RPC
CREATE OR REPLACE FUNCTION public.engine_update_store_settings(
  p_store              uuid,
  p_name               text,
  p_address            text,
  p_phone              text,
  p_google_maps_url    text,
  p_receipt_footer     text,
  p_tax_rc             text,
  p_logo_on_receipt    boolean,
  p_prices_on_receipt  boolean,
  p_return_policy_days integer,
  p_low_stock_alert    integer,
  p_enable_barcode     boolean,
  p_logo_url           text,
  p_store_type         text
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_tenant uuid;
BEGIN
  SELECT tenant_id INTO v_tenant FROM public.stores WHERE id = p_store;
  IF v_tenant IS NULL THEN RAISE EXCEPTION 'المحل غير موجود'; END IF;

  PERFORM public.engine_staff(p_store, v_tenant);

  IF nullif(trim(p_name), '') IS NULL THEN RAISE EXCEPTION 'اسم المحل مطلوب'; END IF;
  IF p_store_type NOT IN ('mens', 'womens') THEN RAISE EXCEPTION 'نوع المتجر مطلوب'; END IF;

  UPDATE public.stores SET
    name               = trim(p_name),
    address            = nullif(trim(p_address), ''),
    phone              = nullif(trim(p_phone), ''),
    google_maps_url    = nullif(trim(p_google_maps_url), ''),
    receipt_footer     = nullif(trim(p_receipt_footer), ''),
    tax_rc             = nullif(trim(p_tax_rc), ''),
    logo_on_receipt    = coalesce(p_logo_on_receipt, false),
    prices_on_receipt  = coalesce(p_prices_on_receipt, false),
    return_policy_days = coalesce(p_return_policy_days, 7),
    low_stock_alert    = coalesce(p_low_stock_alert, 10),
    enable_barcode     = coalesce(p_enable_barcode, true),
    logo_url           = nullif(trim(p_logo_url), ''),
    store_type         = p_store_type
  WHERE id = p_store AND tenant_id = v_tenant;
END $$;

REVOKE ALL ON FUNCTION public.engine_update_store_settings(uuid,text,text,text,text,text,text,boolean,boolean,integer,integer,boolean,text,text)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.engine_update_store_settings(uuid,text,text,text,text,text,text,boolean,boolean,integer,integer,boolean,text,text)
  TO authenticated;

-- -------------------------------------------------------- storefront RPC
-- Public store metadata now carries the type, so the storefront can append the
-- matching women's/men's mock catalogue without a second table query.
CREATE OR REPLACE FUNCTION public.get_store_by_slug(p_slug text)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE s public.stores;
BEGIN
  IF nullif(btrim(coalesce(p_slug, '')), '') IS NULL THEN RETURN NULL; END IF;

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
    'hide_products_without_image', coalesce(s.hide_products_without_image, true),
    'delivery_rates', coalesce(s.delivery_rates, '{}'::jsonb),
    'store_type', coalesce(s.store_type, 'mens')
  );
END $$;

REVOKE ALL ON FUNCTION public.get_store_by_slug(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_store_by_slug(text) TO anon, authenticated;

-- --------------------------------------------------------------- session
-- Branches carry store_type so getAppContext() can expose ctx.storeType even
-- after the owner switches branch. Keeps the P4 trial fields unchanged.
CREATE OR REPLACE FUNCTION public.engine_session() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE u public.users; t public.tenants; result jsonb;
BEGIN
  SELECT * INTO u FROM public.current_staff();
  IF u.id IS NULL THEN RAISE EXCEPTION 'لا يوجد ملف موظف نشط'; END IF;
  SELECT * INTO t FROM public.tenants WHERE id = u.tenant_id;
  SELECT jsonb_build_object(
    'staffId', u.id,
    'role', u.role,
    'tenantId', u.tenant_id,
    'assignedStoreId', u.store_id,
    'storeType', coalesce((SELECT store_type FROM public.stores WHERE id = u.store_id), 'mens'),
    'tenant', jsonb_build_object(
      'id', t.id, 'name', t.name, 'is_active', t.is_active,
      'subscription_end_date', t.subscription_end_date,
      'branches_limit', t.branches_limit,
      'trial_start_date', t.trial_start_date,
      'trial_days', public.trial_days(),
      'trial_ends_at', public.trial_expiry(t),
      'trial_expired', public.trial_expired(t)
    ),
    'stores', coalesce((SELECT jsonb_agg(jsonb_build_object(
                            'id', id, 'name', name,
                            'store_type', coalesce(store_type, 'mens')
                          ) ORDER BY created_at, id)
                          FROM public.stores WHERE tenant_id = u.tenant_id
                           AND (u.role = 'owner' OR id = u.store_id)), '[]'::jsonb)
  ) INTO result;
  RETURN result;
END $$;

REVOKE ALL ON FUNCTION public.engine_session() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.engine_session() TO authenticated;
