-- Security dependency of migration 025: catalog RLS cannot trust a mutable
-- staff/branch identity. UI already uses validated RPCs for directory writes.
SET LOCAL lock_timeout='3s';
CREATE FUNCTION public.p2_directory_read(t uuid,s uuid,a uuid,kind text) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT EXISTS(SELECT 1 FROM public.current_staff() u WHERE u.id IS NOT NULL AND u.tenant_id=t AND (u.role='owner' OR (kind='store' AND u.store_id=s) OR (kind='user' AND (u.auth_id=a OR (u.role='manager' AND u.store_id=s)))))
$$;
REVOKE ALL ON FUNCTION public.p2_directory_read(uuid,uuid,uuid,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.p2_directory_read(uuid,uuid,uuid,text) TO authenticated;
DO $$ DECLARE r record; t text; BEGIN
 FOR r IN SELECT tablename,policyname FROM pg_policies WHERE schemaname='public' AND tablename IN ('users','stores') LOOP EXECUTE format('DROP POLICY %I ON public.%I',r.policyname,r.tablename); END LOOP;
 FOREACH t IN ARRAY ARRAY['users','stores'] LOOP
  EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC,anon,authenticated',t);
  EXECUTE format('GRANT SELECT ON public.%I TO authenticated',t);
 END LOOP;
END $$;
CREATE POLICY tenant_directory_read ON public.users FOR SELECT TO authenticated USING(public.p2_directory_read(tenant_id,store_id,auth_id,'user'));
CREATE POLICY tenant_directory_read ON public.stores FOR SELECT TO authenticated USING(public.p2_directory_read(tenant_id,id,NULL,'store'));
-- SECURITY DEFINER registration/settings RPCs are unchanged and retain their
-- own engine_validate checks. Raw REST cannot reassign tenant/auth/branch data.
NOTIFY pgrst,'reload schema';
