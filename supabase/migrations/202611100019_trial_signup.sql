-- Self-service 7-day trial signup.
--
-- Why this cannot be done from the browser with plain inserts:
--   * `tenants` has RLS enabled with ZERO policies, so an insert is impossible.
--   * `users_write`/`stores_write` require current_role() = 'owner', which
--     resolves through public.users — a brand-new auth user has no row yet.
--   * Letting clients insert into `tenants` directly would let anyone forge
--     `is_active = true` or a past `trial_start_date` and mint free accounts.
--
-- So tenant/store/user creation happens in one SECURITY DEFINER function keyed
-- to auth.uid(). The client only supplies display data, and the server decides
-- every privileged value.
--
-- Auth account creation cannot happen inside SQL (the password must be hashed by
-- GoTrue), so the documented flow is:
--   1. browser: supabase.auth.signUp({ email: '<phone>@vetrina.app', password })
--   2. browser: supabase.auth.signInWithPassword(...)  -> gets a JWT
--   3. browser: rpc('engine_create_trial_tenant', { ... })  -> this file
-- Self-signup is enabled with mailer autoconfirm, so step 2 works immediately.

-- ------------------------------------------------------------------ helpers
CREATE OR REPLACE FUNCTION public.trial_days() RETURNS integer
LANGUAGE sql IMMUTABLE SET search_path=public AS $$ SELECT 7 $$;

-- True when the tenant is an unactivated trial older than trial_days().
-- A tenant with no trial_start_date is treated as NOT locked: legacy tenants
-- must not lose access because of a missing column value.
CREATE OR REPLACE FUNCTION public.trial_expired(p_tenant public.tenants)
RETURNS boolean LANGUAGE sql STABLE SET search_path=public AS $$
  SELECT p_tenant.is_active IS NOT TRUE
     AND p_tenant.trial_start_date IS NOT NULL
     AND now() > p_tenant.trial_start_date + make_interval(days => public.trial_days())
$$;

-- ------------------------------------------------------------- signup RPC
CREATE OR REPLACE FUNCTION public.engine_create_trial_tenant(
  p_store_name text,
  p_owner_name text,
  p_phone text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE
  me uuid := auth.uid();
  tenant_id uuid;
  store_id uuid;
  staff_id uuid;
  normalized text;
  email_local text;
BEGIN
  IF me IS NULL THEN RAISE EXCEPTION 'يرجى تسجيل الدخول أولاً'; END IF;

  -- Idempotency: a double submit or a retried request must not create a second
  -- trial for the same auth account.
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

  -- Keep digits only so '0555 12 34 56' and '+2135551234567' collapse to one id.
  normalized := regexp_replace(coalesce(p_phone, ''), '[^0-9]', '', 'g');
  IF length(normalized) < 8 OR length(normalized) > 20 THEN
    RAISE EXCEPTION 'رقم الهاتف غير صالح';
  END IF;

  -- The auth email is derived from the same phone, so it must match.
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

  INSERT INTO public.stores(tenant_id, name)
  VALUES (tenant_id, btrim(p_store_name))
  RETURNING id INTO store_id;

  INSERT INTO public.users(tenant_id, store_id, username, role, is_active, auth_id, full_name)
  VALUES (tenant_id, store_id, normalized, 'owner', true, me, btrim(p_owner_name))
  RETURNING id INTO staff_id;

  RETURN jsonb_build_object(
    'ok', true,
    'tenant_id', tenant_id,
    'store_id', store_id,
    'staff_id', staff_id,
    'trial_ends_at', now() + make_interval(days => public.trial_days())
  );
END $$;

-- --------------------------------------------------- trial state for the UI
CREATE OR REPLACE FUNCTION public.engine_trial_state()
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public AS $$
DECLARE u public.users; t public.tenants;
BEGIN
  SELECT * INTO u FROM public.current_staff();
  IF u.id IS NULL THEN RETURN jsonb_build_object('ok', false); END IF;
  SELECT * INTO t FROM public.tenants WHERE id = u.tenant_id;
  RETURN jsonb_build_object(
    'ok', true,
    'role', u.role,
    'is_active', t.is_active IS TRUE,
    'trial_start_date', t.trial_start_date,
    'trial_days', public.trial_days(),
    'expired', public.trial_expired(t),
    'days_left', CASE WHEN t.is_active IS NOT TRUE AND t.trial_start_date IS NOT NULL
                      THEN greatest(0, public.trial_days() -
                        floor(extract(epoch FROM (now() - t.trial_start_date)) / 86400)::integer)
                      ELSE NULL END
  );
END $$;

-- Expose the trial flags on the cached session payload so the layout can lock
-- immediately without an extra round trip. Returns exclusive of, or merged into,
-- the existing jsonb_build_object.
CREATE OR REPLACE FUNCTION public.engine_session() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public AS $$
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
    'tenant', jsonb_build_object(
      'id', t.id, 'name', t.name, 'is_active', t.is_active,
      'subscription_end_date', t.subscription_end_date,
      'branches_limit', t.branches_limit,
      'trial_start_date', t.trial_start_date,
      'trial_days', public.trial_days(),
      'trial_expired', public.trial_expired(t)
    ),
    'stores', coalesce((SELECT jsonb_agg(jsonb_build_object('id', id, 'name', name) ORDER BY created_at, id)
                          FROM public.stores WHERE tenant_id = u.tenant_id
                           AND (u.role = 'owner' OR id = u.store_id)), '[]'::jsonb)
  ) INTO result;
  RETURN result;
END $$;

-- ------------------------------------------------------------------ grants
REVOKE ALL ON FUNCTION public.trial_days(), public.trial_expired(public.tenants),
  public.engine_create_trial_tenant(text,text,text), public.engine_trial_state()
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.engine_create_trial_tenant(text,text,text),
  public.engine_trial_state() TO authenticated;

REVOKE ALL ON FUNCTION public.engine_session() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.engine_session() TO authenticated;
