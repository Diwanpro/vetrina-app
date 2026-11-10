-- Trial length is counted in calendar days, not in 7 x 24 hours.
--
-- An owner who signed up at 14:30 used to lose access at 14:30 on day 7, which
-- reads as arbitrary ("why 14:30?"). The trial now runs to midnight at the end
-- of its 7th calendar day, so the rule is "seven days" the way a shopkeeper
-- counts them:
--
--   trial_start_date = 2026-11-10 14:30  ->  expires 2026-11-17 00:00 Algiers
--   (Nov 10 is day 1; the last usable day is Nov 16)
--
-- The operating timezone is a named function so it can be changed in one place.

CREATE OR REPLACE FUNCTION public.trial_timezone() RETURNS text
LANGUAGE sql IMMUTABLE SET search_path=public AS $$ SELECT 'Africa/Algiers' $$;

-- The instant the trial ends: local midnight after the last trial day.
-- Returns NULL when there is no usable start date.
CREATE OR REPLACE FUNCTION public.trial_expiry(p_tenant public.tenants)
RETURNS timestamptz LANGUAGE sql STABLE SET search_path=public AS $$
  SELECT (
    date_trunc('day', p_tenant.trial_start_date AT TIME ZONE public.trial_timezone())
      + make_interval(days => public.trial_days())
  ) AT TIME ZONE public.trial_timezone()
$$;

-- Used from now on instead of the old 7 x 24h comparison. A tenant with no
-- trial_start_date is still treated as NOT locked, so legacy tenants never
-- lose access because of a missing value.
CREATE OR REPLACE FUNCTION public.trial_expired(p_tenant public.tenants)
RETURNS boolean LANGUAGE sql STABLE SET search_path=public AS $$
  SELECT p_tenant.is_active IS NOT TRUE
     AND p_tenant.trial_start_date IS NOT NULL
     AND now() >= public.trial_expiry(p_tenant)
$$;

CREATE OR REPLACE FUNCTION public.engine_trial_state()
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public AS $$
DECLARE u public.users; t public.tenants; ends timestamptz;
BEGIN
  SELECT * INTO u FROM public.current_staff();
  IF u.id IS NULL THEN RETURN jsonb_build_object('ok', false); END IF;
  SELECT * INTO t FROM public.tenants WHERE id = u.tenant_id;
  ends := public.trial_expiry(t);

  RETURN jsonb_build_object(
    'ok', true,
    'role', u.role,
    'is_active', t.is_active IS TRUE,
    'trial_start_date', t.trial_start_date,
    'trial_days', public.trial_days(),
    'trial_ends_at', ends,
    'expired', public.trial_expired(t),
    -- Whole local calendar days still usable, 0 on the day it ends.
    'days_left', CASE WHEN t.is_active IS NOT TRUE AND t.trial_start_date IS NOT NULL
                      THEN greatest(0, (ends AT TIME ZONE public.trial_timezone())::date
                                       - (now() AT TIME ZONE public.trial_timezone())::date)
                      ELSE NULL END
  );
END $$;

-- Expose the end date on the cached session payload too, so the lock screen can
-- tell the owner exactly when access stopped instead of just "expired".
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
      'trial_ends_at', public.trial_expiry(t),
      'trial_expired', public.trial_expired(t)
    ),
    'stores', coalesce((SELECT jsonb_agg(jsonb_build_object('id', id, 'name', name) ORDER BY created_at, id)
                          FROM public.stores WHERE tenant_id = u.tenant_id
                           AND (u.role = 'owner' OR id = u.store_id)), '[]'::jsonb)
  ) INTO result;
  RETURN result;
END $$;

REVOKE ALL ON FUNCTION public.trial_timezone(), public.trial_expiry(public.tenants)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.engine_trial_state() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.engine_trial_state() TO authenticated;
REVOKE ALL ON FUNCTION public.engine_session() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.engine_session() TO authenticated;
