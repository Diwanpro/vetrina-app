-- Super Admin licensing: issuer panel + database-verified activation keys.
--
-- The panel password is NEVER stored in Git or in the browser. Only a bcrypt
-- hash lives in the database-level GUC `app.secret_hash`, set out of band
-- (see supabase/SUPER_ADMIN.md). `engine_activate` no longer trusts the key
-- shape: a key is only valid if the exact row exists in `public.licenses`
-- and it has not been redeemed yet.

-- ---------------------------------------------------------------- rate limit
-- The issuer RPCs are reachable without a login (the panel is password gated),
-- so failed attempts are recorded to slow brute force. Rows are pruned by age.
CREATE TABLE IF NOT EXISTS public.super_admin_attempts(
  id bigserial PRIMARY KEY,
  source text NOT NULL,
  succeeded boolean NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS super_admin_attempts_lookup ON public.super_admin_attempts(source, succeeded, created_at);
REVOKE ALL ON public.super_admin_attempts FROM PUBLIC, anon, authenticated;
REVOKE ALL ON SEQUENCE public.super_admin_attempts_id_seq FROM PUBLIC, anon, authenticated;

-- ------------------------------------------------------------------- helpers
-- Reads the configured bcrypt hash. Returns NULL when the deployment is not
-- yet initialised, which every caller treats as "panel disabled".
CREATE OR REPLACE FUNCTION public.super_secret_hash() RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,extensions AS $$
  SELECT nullif(current_setting('app.secret_hash', true), '')
$$;

-- Returns NULL when the password is accepted, otherwise an Arabic error string.
-- Deliberately returns instead of raising so that failed attempts are COMMITTED
-- (a RAISE would roll the log row back with the rest of the transaction).
CREATE OR REPLACE FUNCTION public.super_admin_guard(p_password text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,extensions AS $$
DECLARE h text; src text; failures integer; valid boolean;
BEGIN
  h := public.super_secret_hash();
  IF h IS NULL THEN RETURN 'لوحة الإدارة غير مهيأة على هذا الخادم'; END IF;

  BEGIN
    src := (current_setting('request.headers', true))::json->>'x-forwarded-for';
  EXCEPTION WHEN OTHERS THEN src := NULL;
  END;
  src := coalesce(nullif(trim(split_part(coalesce(src, ''), ',', 1)), ''), 'local');

  DELETE FROM public.super_admin_attempts WHERE created_at < now() - interval '1 day';

  SELECT count(*) INTO failures FROM public.super_admin_attempts
   WHERE source = src AND succeeded IS FALSE AND created_at > now() - interval '15 minutes';
  IF failures >= 8 THEN RETURN 'محاولات فاشلة كثيرة. أعد المحاولة بعد 15 دقيقة'; END IF;

  valid := false;
  IF p_password IS NOT NULL AND length(p_password) BETWEEN 1 AND 200 THEN
    BEGIN
      valid := extensions.crypt(p_password, h) = h;
    EXCEPTION WHEN OTHERS THEN
      valid := false;
    END;
  END IF;

  IF NOT valid THEN
    INSERT INTO public.super_admin_attempts(source, succeeded) VALUES (src, false);
    RETURN 'كلمة مرور غير صحيحة';
  END IF;

  DELETE FROM public.super_admin_attempts WHERE source = src AND succeeded IS FALSE;
  INSERT INTO public.super_admin_attempts(source, succeeded) VALUES (src, true);
  RETURN NULL;
END $$;

-- -------------------------------------------------------------- key issuing
-- Generates `VTR-{branches}-{6 chars}` or `UPG-{branches}-{6 chars}` using
-- gen_random_bytes. The alphabet is exactly 32 characters, so `byte % 32`
-- carries no modulo bias. Ambiguous glyphs (I, O, 0, 1) are excluded so keys
-- can be read aloud or typed from a screenshot safely.
CREATE OR REPLACE FUNCTION public.engine_admin_generate_license(p_password text, p_type text, p_branches integer)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,extensions AS $$
DECLARE
  err text;
  alphabet text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  prefix text; body text; key text; i integer; attempt integer := 0;
BEGIN
  err := public.super_admin_guard(p_password);
  IF err IS NOT NULL THEN RETURN jsonb_build_object('ok', false, 'error', err); END IF;

  IF p_type IS NULL OR p_type NOT IN ('activation', 'upgrade') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'نوع الترخيص غير صالح');
  END IF;
  IF p_branches IS NULL OR p_branches < 1 OR p_branches > 2147483647 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'عدد الفروع يجب أن يكون بين 1 و 2147483647');
  END IF;

  prefix := CASE p_type WHEN 'activation' THEN 'VTR' ELSE 'UPG' END;

  LOOP
    attempt := attempt + 1;
    body := '';
    FOR i IN 1..6 LOOP
      body := body || substr(alphabet, 1 + (get_byte(extensions.gen_random_bytes(1), 0) % 32), 1);
    END LOOP;
    key := prefix || '-' || p_branches::text || '-' || body;
    BEGIN
      INSERT INTO public.licenses(license_key, license_type, branches) VALUES (key, p_type, p_branches);
      RETURN jsonb_build_object('ok', true, 'license_key', key, 'license_type', p_type, 'branches', p_branches);
    EXCEPTION WHEN unique_violation THEN
      IF attempt >= 12 THEN RETURN jsonb_build_object('ok', false, 'error', 'تعذر توليد مفتاح فريد. أعد المحاولة.'); END IF;
    END;
  END LOOP;
END $$;

-- Recent keys for the panel list. Same password gate; no tenant can reach it.
CREATE OR REPLACE FUNCTION public.engine_admin_list_licenses(p_password text, p_limit integer DEFAULT 50)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,extensions AS $$
DECLARE err text; lim integer;
BEGIN
  err := public.super_admin_guard(p_password);
  IF err IS NOT NULL THEN RETURN jsonb_build_object('ok', false, 'error', err); END IF;

  lim := least(greatest(coalesce(p_limit, 50), 1), 200);
  RETURN jsonb_build_object('ok', true, 'licenses', coalesce((
    SELECT jsonb_agg(jsonb_build_object(
      'id', id,
      'license_key', license_key,
      'license_type', license_type,
      'branches', branches,
      'is_used', coalesce(is_used, false),
      'used_by_tenant_id', used_by_tenant_id,
      'created_at', created_at
    ) ORDER BY created_at DESC, id)
    FROM (SELECT * FROM public.licenses ORDER BY created_at DESC, id LIMIT lim) recent
  ), '[]'::jsonb));
END $$;

-- ------------------------------------------------------- redemption (tenant)
-- Replaces the shape-only check. The key must exist in `public.licenses` and be
-- unredeemed; the row is locked so two tenants cannot claim the same key.
CREATE OR REPLACE FUNCTION public.engine_activate(p_key text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE u public.users; t public.tenants; l public.licenses;
BEGIN
  SELECT * INTO u FROM public.current_staff();
  IF u.id IS NULL OR u.role <> 'owner' THEN RAISE EXCEPTION 'للمالك فقط'; END IF;
  SELECT * INTO t FROM public.tenants WHERE id = u.tenant_id FOR UPDATE;

  p_key := trim(p_key);
  IF length(p_key) > 200 THEN RAISE EXCEPTION 'المفتاح غير صالح'; END IF;

  SELECT * INTO l FROM public.licenses WHERE license_key = p_key FOR UPDATE;
  IF l.id IS NULL THEN
    IF p_key ~ '^(VTR|UPG)-[1-9][0-9]{0,9}-[A-Za-z0-9-]+$' THEN
      RAISE EXCEPTION 'المفتاح غير موجود. تحقق من الرمز أو اطلب مفتاحاً جديداً';
    END IF;
    RAISE EXCEPTION 'استخدم VTR-X-... للتفعيل أو UPG-X-... للترقية';
  END IF;
  IF coalesce(l.is_used, false) OR l.used_by_tenant_id IS NOT NULL THEN
    RAISE EXCEPTION 'هذا المفتاح مستخدم بالفعل';
  END IF;

  IF l.license_type = 'activation' THEN
    IF t.is_active IS TRUE THEN RAISE EXCEPTION 'الحساب نشط. استخدم مفتاح ترقية'; END IF;
    IF l.branches < (SELECT count(*) FROM public.stores WHERE tenant_id = u.tenant_id) THEN
      RAISE EXCEPTION 'المفتاح لا يغطي الفروع الحالية';
    END IF;
    UPDATE public.tenants
       SET is_active = true, is_activated = true, subscription_end_date = null,
           branches_limit = l.branches, subscription_plan = 'lifetime'
     WHERE id = u.tenant_id;
  ELSIF l.license_type = 'upgrade' THEN
    IF t.is_active IS DISTINCT FROM true THEN RAISE EXCEPTION 'فعّل الحساب أولاً'; END IF;
    IF coalesce(t.branches_limit, 0)::bigint + l.branches > 2147483647 THEN
      RAISE EXCEPTION 'تجاوز حد الفروع';
    END IF;
    UPDATE public.tenants SET branches_limit = coalesce(branches_limit, 0) + l.branches
     WHERE id = u.tenant_id;
  ELSE
    RAISE EXCEPTION 'نوع الترخيص غير صالح';
  END IF;

  UPDATE public.licenses SET is_used = true, used_by_tenant_id = u.tenant_id WHERE id = l.id;
  INSERT INTO public.license_redemptions(tenant_id, key_hash) VALUES (u.tenant_id, md5(p_key))
    ON CONFLICT (tenant_id, key_hash) DO NOTHING;
END $$;

-- ------------------------------------------------------------------- grants
-- The guard is internal only: exposing it would hand out a password oracle.
REVOKE ALL ON FUNCTION public.super_secret_hash(), public.super_admin_guard(text),
  public.engine_admin_generate_license(text,text,integer),
  public.engine_admin_list_licenses(text,integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.engine_admin_generate_license(text,text,integer),
  public.engine_admin_list_licenses(text,integer) TO anon, authenticated;

REVOKE ALL ON FUNCTION public.engine_activate(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.engine_activate(text) TO authenticated;
