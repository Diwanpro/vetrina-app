-- Admin-only Auth/profile linkage regression test; all fixtures roll back.
BEGIN;
DO $$
DECLARE u public.users; a uuid; result uuid; test_auth uuid:=gen_random_uuid(); caught boolean; username text:='test_'||replace(gen_random_uuid()::text,'-','');
BEGIN
 SELECT * INTO u FROM public.users WHERE role='owner' AND auth_id IS NOT NULL AND coalesce(is_active,true) LIMIT 1;
 PERFORM set_config('request.jwt.claim.sub',u.auth_id::text,true);
 UPDATE public.tenants SET is_active=true WHERE id=u.tenant_id;
 a:=public.engine_add_store('__employee_registration_test__','');
 INSERT INTO auth.users(id,email,raw_app_meta_data) VALUES(test_auth,username||'@staff.vetrina.dz',jsonb_build_object('created_by_owner',u.auth_id::text));
 result:=public.engine_register_employee(test_auth,username,'employee',a);
 IF NOT EXISTS(SELECT 1 FROM public.users WHERE id=result AND auth_id=test_auth AND tenant_id=u.tenant_id AND store_id=a AND pin_hash IS NULL AND role='employee') THEN RAISE EXCEPTION 'Registration failed'; END IF;
 caught:=false;
 BEGIN PERFORM public.engine_register_employee(u.auth_id,'admin','manager',a); EXCEPTION WHEN OTHERS THEN caught:=true; END;
 IF NOT caught THEN RAISE EXCEPTION 'Unmarked account accepted'; END IF;
 caught:=false;
 BEGIN PERFORM public.engine_register_employee(test_auth,username,'owner',a); EXCEPTION WHEN OTHERS THEN caught:=true; END;
 IF NOT caught THEN RAISE EXCEPTION 'Owner role escalation accepted'; END IF;
END $$;
ROLLBACK;
