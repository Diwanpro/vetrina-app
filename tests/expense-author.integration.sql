-- Admin-only setup followed by authenticated-role RPC calls; rollback-only.
BEGIN;
CREATE TEMP TABLE expense_author_fixture(staff uuid,store uuid);
GRANT SELECT ON expense_author_fixture TO authenticated;
DO $$
DECLARE u public.users; a uuid;
BEGIN
 SELECT * INTO u FROM public.users WHERE role='owner' AND auth_id IS NOT NULL AND coalesce(is_active,true) LIMIT 1;
 PERFORM set_config('request.jwt.claim.sub',u.auth_id::text,true);
 UPDATE public.tenants SET is_active=true WHERE id=u.tenant_id;
 SELECT id INTO a FROM public.stores WHERE tenant_id=u.tenant_id LIMIT 1;
 INSERT INTO expense_author_fixture VALUES(u.id,a);
END $$;
SET LOCAL ROLE authenticated;
DO $$
DECLARE f record; caught boolean;
BEGIN
 SELECT * INTO f FROM expense_author_fixture;
 PERFORM public.engine_record_expense_for_staff(f.store,10,'authenticated wrapper test',null,gen_random_uuid(),f.staff);
 caught:=false;
 BEGIN PERFORM public.engine_record_expense_for_staff(f.store,10,'wrong author',null,gen_random_uuid(),gen_random_uuid()); EXCEPTION WHEN OTHERS THEN caught:=true; END;
 IF NOT caught THEN RAISE EXCEPTION 'Wrong expense author accepted'; END IF;
 IF has_function_privilege('authenticated','public.engine_record_expense(uuid,integer,text,text,uuid)','execute') OR has_function_privilege('authenticated','public.engine_register_employee(uuid,text,text,uuid)','execute') THEN RAISE EXCEPTION 'Bare mutation RPC still callable'; END IF;
END $$;
RESET ROLE;
ROLLBACK;
