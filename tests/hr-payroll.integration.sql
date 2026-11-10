-- Admin-only rollback regression checks. No account/financial fixtures persist.
BEGIN;
DO $$
DECLARE owner public.users; branch uuid; employee uuid; test_auth uuid; username text; kind text; rate numeric; payslip jsonb; overview jsonb; caught boolean; first_day date:=(date_trunc('month',now() AT TIME ZONE 'Africa/Algiers'))::date; today date:=(now() AT TIME ZONE 'Africa/Algiers')::date;
BEGIN
 SELECT * INTO owner FROM public.users WHERE role='owner' AND auth_id IS NOT NULL AND coalesce(is_active,true) LIMIT 1;
 IF owner.id IS NULL THEN RAISE EXCEPTION 'Owner fixture missing'; END IF;
 UPDATE public.tenants SET is_active=true WHERE id=owner.tenant_id;
 SELECT id INTO branch FROM public.stores WHERE tenant_id=owner.tenant_id LIMIT 1;
 PERFORM set_config('request.jwt.claim.sub',owner.auth_id::text,true);
 FOREACH kind IN ARRAY ARRAY['fixed','commission','fixed_commission','daily'] LOOP
  test_auth:=gen_random_uuid(); username:='hr_'||replace(gen_random_uuid()::text,'-','');
  INSERT INTO auth.users(id,email,raw_app_meta_data) VALUES(test_auth,username||'@staff.vetrina.dz',jsonb_build_object('created_by_owner',owner.auth_id::text));
  employee:=public.engine_register_employee_hr(test_auth,username,'employee',branch,'أحمد','علي',kind,30000,5);
  IF NOT EXISTS(SELECT 1 FROM public.users WHERE id=employee AND salary_type=kind AND commission_percentage=CASE WHEN kind IN ('commission','fixed_commission') THEN 5 ELSE 0 END AND salary_amount=CASE WHEN kind='commission' THEN 0 ELSE 30000 END) THEN RAISE EXCEPTION 'Salary normalization failed: %',kind; END IF;
 END LOOP;
 -- Last employee is daily; turn this fixture into a combined salary contract.
 UPDATE public.users SET salary_type='fixed_commission',commission_percentage=5 WHERE id=employee;
 PERFORM set_config('request.jwt.claim.sub',test_auth::text,true);
 PERFORM public.engine_mark_attendance(employee); PERFORM public.engine_mark_attendance(employee);
 IF (SELECT count(*) FROM public.employee_attendance WHERE user_id=employee AND attendance_date=today)<>1 THEN RAISE EXCEPTION 'Attendance duplicated'; END IF;
 caught:=false; BEGIN PERFORM public.engine_mark_attendance(gen_random_uuid()); EXCEPTION WHEN OTHERS THEN caught:=true; END;
 IF NOT caught THEN RAISE EXCEPTION 'Wrong attendance author accepted'; END IF;
 INSERT INTO public.sales(user_id,store_id,total_amount,created_at) VALUES(employee,branch,20000,now()),(employee,branch,10000,first_day::timestamp AT TIME ZONE 'Africa/Algiers'),(employee,branch,999999,(first_day-1)::timestamp AT TIME ZONE 'Africa/Algiers');
 IF NOT EXISTS(SELECT 1 FROM public.employee_attendance WHERE user_id=employee AND attendance_date=first_day) OR (SELECT count(*) FROM public.employee_attendance WHERE user_id=employee AND attendance_date=today)<>1 THEN RAISE EXCEPTION 'Sale attendance or idempotency failed'; END IF;
 INSERT INTO public.employee_advances(user_id,amount,created_at,store_id) VALUES(employee,5000,now(),branch),(employee,99999,(first_day-1)::timestamp AT TIME ZONE 'Africa/Algiers',branch);
 caught:=false; BEGIN PERFORM public.engine_payslip(employee); EXCEPTION WHEN OTHERS THEN caught:=true; END;
 IF NOT caught THEN RAISE EXCEPTION 'Employee payslip access accepted'; END IF;
 PERFORM set_config('request.jwt.claim.sub',owner.auth_id::text,true);
 payslip:=public.engine_payslip(employee);
 IF (payslip->>'total_sales')::numeric<>30000 OR (payslip->>'commissions')::numeric<>1500 OR (payslip->>'advances')::numeric<>5000 OR (payslip->>'net_payable')::numeric<>26500 THEN RAISE EXCEPTION 'Payslip amounts failed: %',payslip; END IF;
 overview:=public.engine_hr_overview(branch);
 IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(overview) x WHERE x->>'id'=employee::text AND (x->>'attendance_days')::integer=CASE WHEN today=first_day THEN 1 ELSE 2 END) THEN RAISE EXCEPTION 'Monthly attendance count failed'; END IF;
 caught:=false; BEGIN PERFORM public.engine_payslip(gen_random_uuid()); EXCEPTION WHEN OTHERS THEN caught:=true; END;
 IF NOT caught THEN RAISE EXCEPTION 'Unknown employee accepted'; END IF;
 FOREACH rate IN ARRAY ARRAY[-1::numeric,100.01,5.001] LOOP
  caught:=false; BEGIN PERFORM public.engine_register_employee_hr(test_auth,username,'employee',branch,'أحمد','علي','fixed_commission',30000,rate); EXCEPTION WHEN OTHERS THEN caught:=true; END;
  IF NOT caught THEN RAISE EXCEPTION 'Invalid commission accepted'; END IF;
 END LOOP;
END $$;
ROLLBACK;
