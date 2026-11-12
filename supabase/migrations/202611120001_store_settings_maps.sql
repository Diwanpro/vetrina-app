-- The settings screen has always called engine_update_store_settings, but the
-- function was never created, so every save on إعدادات المحل was failing.
-- Adds the missing RPC, the phone column and the Google Maps link.

ALTER TABLE public.stores ADD COLUMN IF NOT EXISTS phone text;
ALTER TABLE public.stores ADD COLUMN IF NOT EXISTS google_maps_url text;

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
  p_logo_url           text
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_tenant uuid;
BEGIN
  SELECT tenant_id INTO v_tenant FROM public.stores WHERE id = p_store;
  IF v_tenant IS NULL THEN RAISE EXCEPTION 'المحل غير موجود'; END IF;

  -- Raises unless the caller is owner/manager of this store in this tenant.
  PERFORM public.engine_staff(p_store, v_tenant);

  IF nullif(trim(p_name), '') IS NULL THEN RAISE EXCEPTION 'اسم المحل مطلوب'; END IF;

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
    logo_url           = nullif(trim(p_logo_url), '')
  WHERE id = p_store AND tenant_id = v_tenant;
END $$;

REVOKE ALL ON FUNCTION public.engine_update_store_settings(uuid,text,text,text,text,text,text,boolean,boolean,integer,integer,boolean,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.engine_update_store_settings(uuid,text,text,text,text,text,text,boolean,boolean,integer,integer,boolean,text) TO authenticated;
