-- v3.2: the Masculine storefront theme becomes a real, selectable theme.
--
-- The look itself lives in the storefront CSS/theme engine; this migration only
-- widens the stored theme_key so a branch can persist 'masculine' next to
-- 'classic' and 'feminine', and updates the three RPCs that validate it.
--
-- Standing rules kept from the originals: no orders access, SECURITY DEFINER
-- with a pinned search_path, and the same tenant/ownership checks.
-- CREATE OR REPLACE preserves the existing EXECUTE grants.

-- ------------------------------------------------------------------ stores
ALTER TABLE public.stores DROP CONSTRAINT IF EXISTS stores_theme_key_check;
ALTER TABLE public.stores ADD CONSTRAINT stores_theme_key_check
  CHECK (theme_key IN ('classic', 'feminine', 'masculine'));

-- ------------------------------------------------------- settings save RPC
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
  IF p_theme_key NOT IN ('classic', 'feminine', 'masculine') THEN RAISE EXCEPTION 'قالب المتجر غير صالح'; END IF;

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

-- ------------------------------------------------------- per-branch profile
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
  IF p_theme_key NOT IN ('classic', 'feminine', 'masculine') THEN RAISE EXCEPTION 'قالب المتجر غير صالح'; END IF;
  UPDATE public.stores
     SET store_type = p_store_type, theme_key = p_theme_key
   WHERE id = p_store AND tenant_id = v_tenant;
END $$;

-- ------------------------------------------------------- per-branch specialty
CREATE OR REPLACE FUNCTION public.engine_set_branch_specialty(p_store uuid,p_store_type text,p_theme_key text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE t uuid;
BEGIN
 SELECT tenant_id INTO t FROM public.stores WHERE id=p_store;
 PERFORM public.engine_staff(p_store,t);
 IF p_store_type IS NULL OR p_theme_key IS NULL OR p_store_type NOT IN ('mens','womens','mixed') OR p_theme_key NOT IN ('classic','feminine','masculine') THEN RAISE EXCEPTION 'تخصص أو قالب غير صالح'; END IF;
 UPDATE public.stores SET store_type=p_store_type,theme_key=p_theme_key WHERE id=p_store;
END $$;
