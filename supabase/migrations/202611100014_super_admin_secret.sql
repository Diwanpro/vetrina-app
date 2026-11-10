-- Stores the Super Admin password as a bcrypt hash.
--
-- Supabase's API role cannot run ALTER DATABASE, so a database-level GUC is not
-- available here. The hash lives in a single-row table instead, readable only
-- through the SECURITY DEFINER helper. RLS is on with NO policies and every
-- table privilege is revoked, so anon/authenticated clients cannot select it
-- even with a valid JWT.
--
-- The plaintext password is never stored in this file, in Git, or in the
-- browser. Only a bcrypt hash is provisioned below.
-- See supabase/SUPER_ADMIN.md for rotation instructions.

CREATE TABLE IF NOT EXISTS public.app_settings(
  key text PRIMARY KEY,
  value text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.app_settings ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.app_settings FROM PUBLIC, anon, authenticated;

-- Reads the configured bcrypt hash. Returns NULL when not initialised, which
-- every caller treats as "panel disabled".
CREATE OR REPLACE FUNCTION public.super_secret_hash() RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,extensions AS $$
  SELECT nullif(btrim(value), '') FROM public.app_settings WHERE key = 'super_admin_password_hash'
$$;

REVOKE ALL ON FUNCTION public.super_secret_hash() FROM PUBLIC, anon, authenticated;

-- Initial password hash (bcrypt, cost 12). Provisioned once; the ON CONFLICT
-- clause makes a re-run a no-op so a deployment cannot silently reset it.
INSERT INTO public.app_settings(key, value)
VALUES ('super_admin_password_hash', '$2a$12$BIrJ9GKzkjT/CBswxfeo/eULG239Gohakusbsy2QeJT/6jmQRsQWS')
ON CONFLICT (key) DO NOTHING;
