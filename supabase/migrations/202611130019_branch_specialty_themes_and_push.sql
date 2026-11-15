-- v3.1: branch-level specialty, branch-owned theme choice, and branch-scoped
-- Web Push subscriptions.
--
-- Standing shipping rules are kept:
--   * public.orders is NEVER altered/updated/inserted/deleted here;
--   * staff/session RPCs stay SECURITY DEFINER with pinned search_path;
--   * anon never gets write access; the push table is service-role only;
--   * old overlapping [seed] demo rows stay hidden, not deleted.
--
-- Business rule corrected by the merchant: «تخصص الفرع» belongs to the BRANCH.
-- One account may own a men's branch, a women's branch and a mixed branch.

-- ------------------------------------------------------------------ stores
ALTER TABLE public.stores DROP CONSTRAINT IF EXISTS stores_store_type_check;
ALTER TABLE public.stores ADD CONSTRAINT stores_store_type_check
  CHECK (store_type IN ('mens', 'womens', 'mixed'));

ALTER TABLE public.stores ADD COLUMN IF NOT EXISTS theme_key text;
UPDATE public.stores
   SET theme_key = 'classic'
 WHERE theme_key IS NULL OR theme_key NOT IN ('classic', 'feminine');
ALTER TABLE public.stores ALTER COLUMN theme_key SET DEFAULT 'classic';
ALTER TABLE public.stores ALTER COLUMN theme_key SET NOT NULL;
ALTER TABLE public.stores DROP CONSTRAINT IF EXISTS stores_theme_key_check;
ALTER TABLE public.stores ADD CONSTRAINT stores_theme_key_check
  CHECK (theme_key IN ('classic', 'feminine'));

-- Idempotent cleanup of the old mixed hand-run demo catalogue. The clean P5
-- mock lists in lib/mock-catalog.js replace it in the dashboard and storefront.
UPDATE public.products SET is_active = false WHERE name LIKE '[seed] %';

-- Demo seed: three branches of ONE tenant with three different specialties.
-- Only the two known demo slugs are touched; real merchant branches keep their
-- own values. «متعدد» deliberately chooses the feminine theme to show that the
-- merchant's theme choice is independent of the account.
UPDATE public.stores
   SET store_type = 'mixed', theme_key = 'feminine'
 WHERE slug = 'seed-branch-2';
UPDATE public.stores
   SET store_type = 'womens'
 WHERE slug = 'seed-branch-3';

-- -------------------------------------------------- push subscriptions table
-- Customer subscriptions are stored PER BRANCH. RLS is enabled with NO policies:
-- only the service role (used by Next.js Route Handlers) can read or write them.
CREATE TABLE IF NOT EXISTS public.push_subscriptions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id    uuid NOT NULL REFERENCES public.stores(id) ON DELETE CASCADE,
  tenant_id   uuid NOT NULL,
  endpoint    text NOT NULL UNIQUE,
  p256dh      text NOT NULL,
  auth        text NOT NULL,
  user_agent  text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS push_subscriptions_store_idx
  ON public.push_subscriptions (store_id);
ALTER TABLE public.push_subscriptions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.push_subscriptions FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.push_subscriptions TO service_role;

-- -------------------------------------------------------------- signup RPC
-- Four-argument overload: the FIRST BRANCH declares its mandatory specialty.
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
  IF p_store_type NOT IN ('mens', 'womens', 'mixed') THEN
    RAISE EXCEPTION 'تخصص الفرع مطلوب';
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

-- ------------------------------------------------------------ new branch RPC
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
  IF p_store_type NOT IN ('mens', 'womens', 'mixed') THEN RAISE EXCEPTION 'تخصص الفرع مطلوب'; END IF;
  INSERT INTO public.stores(tenant_id, name, address, store_type)
  VALUES (u.tenant_id, trim(p_name), nullif(trim(p_address), ''), p_store_type)
  RETURNING id INTO result;
  RETURN result;
END $$;

-- The old two-argument overload would create a branch with the column default
-- and skip the mandatory specialty. It stays for server-side scripts, but no
-- browser role may call it.
REVOKE ALL ON FUNCTION public.engine_add_store(text,text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.engine_add_store(text,text,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.engine_add_store(text,text,text) TO authenticated;

-- ------------------------------------------------------------ settings RPC
-- A branch edit saves specialty + the «متعدد» default theme in ONE call.
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
  p_store_type         text,
  p_theme_key          text
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_tenant uuid;
BEGIN
  SELECT tenant_id INTO v_tenant FROM public.stores WHERE id = p_store;
  IF v_tenant IS NULL THEN RAISE EXCEPTION 'المحل غير موجود'; END IF;

  PERFORM public.engine_staff(p_store, v_tenant);

  IF nullif(trim(p_name), '') IS NULL THEN RAISE EXCEPTION 'اسم المحل مطلوب'; END IF;
  IF p_store_type NOT IN ('mens', 'womens', 'mixed') THEN RAISE EXCEPTION 'تخصص الفرع مطلوب'; END IF;
  IF p_theme_key NOT IN ('classic', 'feminine') THEN RAISE EXCEPTION 'قالب المتجر غير صالح'; END IF;

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
    store_type         = p_store_type,
    theme_key          = p_theme_key
  WHERE id = p_store AND tenant_id = v_tenant;
END $$;

-- Older overloads (12/13/14 arguments) would let a browser save settings
-- without a specialty or a theme. Revoke them from every client role; the
-- 14-argument P5 overload is dropped outright.
REVOKE ALL ON FUNCTION public.engine_update_store_settings(uuid,text,text,text,text,text,boolean,boolean,integer,integer,boolean,text)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.engine_update_store_settings(uuid,text,text,text,text,text,text,boolean,boolean,integer,integer,boolean,text)
  FROM PUBLIC, anon, authenticated;
DROP FUNCTION IF EXISTS public.engine_update_store_settings(uuid,text,text,text,text,text,text,boolean,boolean,integer,integer,boolean,text,text);
REVOKE ALL ON FUNCTION public.engine_update_store_settings(uuid,text,text,text,text,text,text,boolean,boolean,integer,integer,boolean,text,text,text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.engine_update_store_settings(uuid,text,text,text,text,text,text,boolean,boolean,integer,integer,boolean,text,text,text)
  TO authenticated;

-- -------------------------------------------------- per-branch profile RPCs
CREATE OR REPLACE FUNCTION public.engine_list_branch_profiles()
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE u public.users; result jsonb;
BEGIN
  SELECT * INTO u FROM public.current_staff();
  IF u.id IS NULL OR u.role <> 'owner' THEN RAISE EXCEPTION 'للمالك فقط'; END IF;
  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'id', id,
           'name', name,
           'slug', slug,
           'store_type', coalesce(store_type, 'mens'),
           'theme_key', coalesce(theme_key, 'classic')
         ) ORDER BY created_at, id), '[]'::jsonb)
    INTO result
    FROM public.stores
   WHERE tenant_id = u.tenant_id;
  RETURN result;
END $$;

CREATE OR REPLACE FUNCTION public.engine_set_branch_profile(
  p_store uuid, p_store_type text, p_theme_key text
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE u public.users; v_tenant uuid;
BEGIN
  SELECT * INTO u FROM public.current_staff();
  IF u.id IS NULL OR u.role <> 'owner' THEN RAISE EXCEPTION 'للمالك فقط'; END IF;
  SELECT tenant_id INTO v_tenant FROM public.stores WHERE id = p_store;
  IF v_tenant IS NULL OR v_tenant <> u.tenant_id THEN RAISE EXCEPTION 'فرع غير صالح'; END IF;
  PERFORM public.engine_staff(p_store, v_tenant);
  IF p_store_type NOT IN ('mens', 'womens', 'mixed') THEN RAISE EXCEPTION 'تخصص الفرع مطلوب'; END IF;
  IF p_theme_key NOT IN ('classic', 'feminine') THEN RAISE EXCEPTION 'قالب المتجر غير صالح'; END IF;
  UPDATE public.stores
     SET store_type = p_store_type, theme_key = p_theme_key
   WHERE id = p_store AND tenant_id = v_tenant;
END $$;

REVOKE ALL ON FUNCTION public.engine_list_branch_profiles() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.engine_list_branch_profiles() TO authenticated;
REVOKE ALL ON FUNCTION public.engine_set_branch_profile(uuid,text,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.engine_set_branch_profile(uuid,text,text) TO authenticated;

-- ---------------------------------------------------------- public storefront
-- The public store learns its slug, specialty and merchant-chosen theme key;
-- the Theme Engine resolves the effective template from those three values.
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
    'slug', s.slug,
    'name', s.name,
    'logo_url', s.logo_url,
    'phone', s.phone,
    'address', s.address,
    'google_maps_url', s.google_maps_url,
    'show_prices', coalesce(s.show_prices, true),
    'accepts_orders', coalesce(s.accepts_orders, false),
    'hide_products_without_image', coalesce(s.hide_products_without_image, true),
    'delivery_rates', coalesce(s.delivery_rates, '{}'::jsonb),
    'store_type', coalesce(s.store_type, 'mens'),
    'theme_key', coalesce(s.theme_key, 'classic')
  );
END $$;

REVOKE ALL ON FUNCTION public.get_store_by_slug(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_store_by_slug(text) TO anon, authenticated;

-- --------------------------------------------------------------- session RPC
-- engine_session() exposes every branch's own specialty and theme. Branch
-- switching therefore changes ctx.storeType / ctx.storeTheme immediately.
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
    'themeKey', coalesce((SELECT theme_key FROM public.stores WHERE id = u.store_id), 'classic'),
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
                            'id', id, 'name', name, 'slug', slug,
                            'store_type', coalesce(store_type, 'mens'),
                            'theme_key', coalesce(theme_key, 'classic')
                          ) ORDER BY created_at, id)
                          FROM public.stores WHERE tenant_id = u.tenant_id
                           AND (u.role = 'owner' OR id = u.store_id)), '[]'::jsonb)
  ) INTO result;
  RETURN result;
END $$;

REVOKE ALL ON FUNCTION public.engine_session() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.engine_session() TO authenticated;
