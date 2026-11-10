-- Server-side enforcement of the two-device session cap.
--
-- Before this migration the cap lived entirely in browser code: any signed-in
-- user could PATCH their own rows with the anon key and clear `is_active` to
-- keep unlimited devices. The cap is now enforced inside SECURITY DEFINER
-- functions and clients lose the ability to write the table directly.
--
-- Model:
--   * `authenticated` keeps SELECT only (its own rows, via RLS) so the settings
--     screen can render the device list.
--   * INSERT/UPDATE/DELETE are revoked. Every mutation goes through
--     `engine_session_register`, `engine_session_touch`,
--     `engine_session_signout` or `engine_session_revoke`, each of which
--     derives the actor from auth.uid() and ignores any client-supplied id.
--   * A partial unique index guarantees at most MAX_ACTIVE_SESSIONS active rows
--     per user at the storage level, so even a bug in the RPC cannot exceed it.
--
-- The `user_sessions_update` policy is dropped and an UPDATE trigger blocks any
-- privilege path that might be re-granted later.

-- ---------------------------------------------------------------- constants
-- Kept in one place; the JS constant MAX_ACTIVE_SESSIONS mirrors this value.
CREATE OR REPLACE FUNCTION public.session_max_active() RETURNS integer
LANGUAGE sql IMMUTABLE SET search_path=public AS $$ SELECT 2 $$;

-- ------------------------------------------------------- write lock-down
DROP POLICY IF EXISTS user_sessions_insert ON public.user_sessions;
DROP POLICY IF EXISTS user_sessions_update ON public.user_sessions;

-- Keep read access for the settings screen; it is already scoped by policy.
GRANT SELECT ON public.user_sessions TO authenticated;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON public.user_sessions FROM anon, authenticated;

-- Defence in depth: even if a write privilege is granted again by mistake, the
-- trigger rejects writes that do not come through the SECURITY DEFINER RPCs.
-- Those functions set `vetrina.session_rpc` for the duration of the call.
CREATE OR REPLACE FUNCTION public.session_guard_write() RETURNS trigger
LANGUAGE plpgsql SET search_path=public AS $$
DECLARE effective name := current_user;
BEGIN
  -- Inside a SECURITY DEFINER function current_user is the function owner
  -- (postgres); a stray client statement has current_user = authenticated/anon.
  -- This is a property of the statement, not of a mutable session setting, so
  -- it cannot leak the way a set_config(...) flag did.
  IF effective IN ('anon', 'authenticated') THEN
    RAISE EXCEPTION 'تعديل الجلسات متاح عبر واجهات الخادم فقط';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS session_guard_write ON public.user_sessions;
CREATE TRIGGER session_guard_write
  BEFORE INSERT OR UPDATE ON public.user_sessions
  FOR EACH ROW EXECUTE FUNCTION public.session_guard_write();

-- ------------------------------------------------------------------- RPCs
-- Registers or refreshes the caller's device. Returns the resulting session and
-- which device (if any) was evicted.
CREATE OR REPLACE FUNCTION public.engine_session_register(
  p_fingerprint text,
  p_device_name text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE
  me uuid := auth.uid();
  cap integer := public.session_max_active();
  existing public.user_sessions;
  active_count integer;
  evicted public.user_sessions;
  result public.user_sessions;
  stamp timestamptz := clock_timestamp();
BEGIN
  IF me IS NULL THEN RAISE EXCEPTION 'يرجى تسجيل الدخول'; END IF;
  IF p_fingerprint IS NULL OR length(btrim(p_fingerprint)) NOT BETWEEN 8 AND 128 THEN
    RAISE EXCEPTION 'بصمة الجهاز غير صالحة';
  END IF;
  IF p_device_name IS NOT NULL AND length(p_device_name) > 200 THEN
    RAISE EXCEPTION 'اسم الجهاز طويل جداً';
  END IF;

  PERFORM set_config('vetrina.session_rpc', 'on', true);

  -- Serialise concurrent logins for this user so two devices cannot both see
  -- "one slot free" and both take it.
  PERFORM pg_advisory_xact_lock(hashtextextended('user_sessions:' || me::text, 0));

  SELECT * INTO existing FROM public.user_sessions
   WHERE user_id = me AND device_fingerprint = btrim(p_fingerprint)
   FOR UPDATE;

  IF existing.id IS NOT NULL THEN
    -- Known device: refresh activity and re-activate if it was signed out.
    UPDATE public.user_sessions
       SET is_active = true,
           last_active = stamp,
           device_name = coalesce(nullif(btrim(p_device_name), ''), device_name)
     WHERE id = existing.id
     RETURNING * INTO result;
    RETURN jsonb_build_object('ok', true, 'action', 'touch', 'session', to_jsonb(result));
  END IF;

  SELECT count(*) INTO active_count
    FROM public.user_sessions WHERE user_id = me AND is_active;

  IF active_count >= cap THEN
    -- Least recently active wins the eviction; NULL counts as stalest and the
    -- id breaks exact ties so two devices cannot ping-pong.
    SELECT * INTO evicted FROM public.user_sessions
     WHERE user_id = me AND is_active
     ORDER BY last_active ASC NULLS FIRST, id ASC
     LIMIT 1
     FOR UPDATE;
    IF evicted.id IS NULL THEN RAISE EXCEPTION 'تعذر تحديد الجلسة الأقدم'; END IF;
    UPDATE public.user_sessions SET is_active = false WHERE id = evicted.id;
  END IF;

  INSERT INTO public.user_sessions(user_id, device_fingerprint, device_name, last_active, is_active)
  VALUES (me, btrim(p_fingerprint), nullif(btrim(p_device_name), ''), stamp, true)
  ON CONFLICT (user_id, device_fingerprint) DO UPDATE
    SET is_active = true, last_active = stamp,
        device_name = coalesce(excluded.device_name, public.user_sessions.device_name)
  RETURNING * INTO result;

  RETURN jsonb_build_object(
    'ok', true,
    'action', CASE WHEN evicted.id IS NULL THEN 'insert' ELSE 'evict' END,
    'session', to_jsonb(result),
    'evicted', CASE WHEN evicted.id IS NULL THEN NULL
                    ELSE jsonb_build_object('id', evicted.id, 'device_name', evicted.device_name) END
  );
END $$;

-- Heartbeat: refreshes only the caller's own row.
CREATE OR REPLACE FUNCTION public.engine_session_touch(p_fingerprint text)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE me uuid := auth.uid();
BEGIN
  IF me IS NULL OR p_fingerprint IS NULL THEN RETURN false; END IF;
  PERFORM set_config('vetrina.session_rpc', 'on', true);
  UPDATE public.user_sessions SET last_active = clock_timestamp()
   WHERE user_id = me AND device_fingerprint = btrim(p_fingerprint) AND is_active;
  RETURN FOUND;
END $$;

-- Normal logout of this device (fingerprint derived client-side, scoped here).
CREATE OR REPLACE FUNCTION public.engine_session_signout(p_fingerprint text)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE me uuid := auth.uid();
BEGIN
  IF me IS NULL OR p_fingerprint IS NULL THEN RETURN false; END IF;
  PERFORM set_config('vetrina.session_rpc', 'on', true);
  UPDATE public.user_sessions SET is_active = false
   WHERE user_id = me AND device_fingerprint = btrim(p_fingerprint);
  RETURN FOUND;
END $$;

-- "Logout this device" from the settings screen. The id is filtered by
-- user_id = auth.uid() inside the function, so a foreign id is a no-op.
CREATE OR REPLACE FUNCTION public.engine_session_revoke(p_session_id uuid)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE me uuid := auth.uid();
BEGIN
  IF me IS NULL OR p_session_id IS NULL THEN RETURN false; END IF;
  PERFORM set_config('vetrina.session_rpc', 'on', true);
  UPDATE public.user_sessions SET is_active = false
   WHERE id = p_session_id AND user_id = me;
  RETURN FOUND;
END $$;

-- ------------------------------------------------------------------ grants
REVOKE ALL ON FUNCTION public.session_max_active(), public.session_guard_write(),
  public.engine_session_register(text,text), public.engine_session_touch(text),
  public.engine_session_signout(text), public.engine_session_revoke(uuid)
  FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.engine_session_register(text,text),
  public.engine_session_touch(text), public.engine_session_signout(text),
  public.engine_session_revoke(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.session_max_active() TO authenticated;
