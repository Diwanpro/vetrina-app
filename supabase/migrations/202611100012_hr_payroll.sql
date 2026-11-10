ALTER TABLE public.users ADD COLUMN commission_percentage numeric(5,2) NOT NULL DEFAULT 0 CHECK(commission_percentage>=0 AND commission_percentage<=100);
-- Replace the old signature to avoid PostgREST overload ambiguity. Default 0
-- preserves existing fixed/daily callers; commission callers must send a rate.
DROP FUNCTION public.engine_register_employee_hr(uuid,text,text,uuid,text,text,text,integer);
CREATE FUNCTION public.engine_register_employee_hr(p_auth uuid,p_username text,p_role text,p_store uuid,p_first text,p_last text,p_salary_type text,p_salary_amount integer,p_commission_percentage numeric DEFAULT 0) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE result uuid;
BEGIN
 IF nullif(trim(p_first),'') IS NULL OR nullif(trim(p_last),'') IS NULL OR length(p_first)>100 OR length(p_last)>100 OR p_salary_type IS NULL OR p_salary_type NOT IN ('fixed','commission','fixed_commission','daily') OR p_salary_amount IS NULL OR p_salary_amount<0 OR p_commission_percentage IS NULL OR p_commission_percentage NOT BETWEEN 0 AND 100 OR p_commission_percentage<>round(p_commission_percentage,2) THEN RAISE EXCEPTION 'بيانات الأجر غير صالحة'; END IF;
 result:=public.engine_register_employee(p_auth,p_username,p_role,p_store);
 UPDATE public.users SET first_name=trim(p_first),last_name=trim(p_last),full_name=trim(p_first)||' '||trim(p_last),salary_type=p_salary_type,salary_amount=CASE WHEN p_salary_type='commission' THEN 0 ELSE p_salary_amount END,commission_percentage=CASE WHEN p_salary_type IN ('commission','fixed_commission') THEN p_commission_percentage ELSE 0 END WHERE id=result;
 RETURN result;
END $$;
CREATE FUNCTION public.engine_hr_overview(p_store uuid DEFAULT null) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public AS $$
DECLARE u public.users; month_start date:=(date_trunc('month',now() AT TIME ZONE 'Africa/Algiers'))::date;
BEGIN
 SELECT * INTO u FROM public.current_staff(); IF u.id IS NULL OR u.role<>'owner' THEN RAISE EXCEPTION 'للمالك فقط'; END IF;
 IF p_store IS NOT NULL THEN PERFORM public.engine_validate(p_store,u.tenant_id,ARRAY['owner']); END IF;
 RETURN coalesce((SELECT jsonb_agg(jsonb_build_object('id',e.id,'username',e.username,'first_name',e.first_name,'last_name',e.last_name,'full_name',e.full_name,'salary_type',e.salary_type,'salary_amount',e.salary_amount,'commission_percentage',e.commission_percentage,'role',e.role,'store_id',e.store_id,'is_active',e.is_active,'attendance_days',(SELECT count(DISTINCT a.attendance_date) FROM public.employee_attendance a WHERE a.user_id=e.id AND a.status='present' AND a.attendance_date>=month_start AND a.attendance_date<(month_start+interval '1 month')::date)) ORDER BY e.username,e.id) FROM public.users e WHERE e.tenant_id=u.tenant_id AND e.role IN ('manager','employee') AND (p_store IS NULL OR e.store_id=p_store)),'[]'::jsonb);
END $$;
CREATE FUNCTION public.engine_payslip(p_user uuid) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public AS $$
DECLARE u public.users; e public.users; start_date date:=(date_trunc('month',now() AT TIME ZONE 'Africa/Algiers'))::date; from_time timestamptz; to_time timestamptz; sales numeric; advances numeric; commission numeric;
BEGIN
 SELECT * INTO u FROM public.current_staff(); IF u.id IS NULL OR u.role<>'owner' THEN RAISE EXCEPTION 'للمالك فقط'; END IF;
 SELECT * INTO e FROM public.users WHERE id=p_user AND tenant_id=u.tenant_id AND role IN ('manager','employee');
 IF e.id IS NULL THEN RAISE EXCEPTION 'الموظف غير متاح'; END IF;
 from_time:=start_date::timestamp AT TIME ZONE 'Africa/Algiers'; to_time:=(start_date+interval '1 month') AT TIME ZONE 'Africa/Algiers';
 SELECT coalesce(sum(s.total_amount),0) INTO sales FROM public.sales s JOIN public.stores store ON store.id=s.store_id WHERE s.user_id=e.id AND store.tenant_id=u.tenant_id AND s.status='completed' AND s.created_at>=from_time AND s.created_at<to_time;
 SELECT coalesce(sum(a.amount),0) INTO advances FROM public.employee_advances a WHERE a.user_id=e.id AND a.created_at>=from_time AND a.created_at<to_time;
 commission:=round(sales*coalesce(e.commission_percentage,0)/100,2);
 RETURN jsonb_build_object('employee',jsonb_build_object('id',e.id,'name',coalesce(e.full_name,e.username),'username',e.username,'salary_type',e.salary_type),'month',start_date,'base_salary',coalesce(e.salary_amount,0),'commission_percentage',e.commission_percentage,'total_sales',sales,'commissions',commission,'advances',advances,'net_payable',coalesce(e.salary_amount,0)+commission-advances);
END $$;
CREATE FUNCTION public.engine_mark_attendance(p_staff uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE u public.users;
BEGIN
 SELECT * INTO u FROM public.current_staff(); IF u.id IS NULL OR u.id IS DISTINCT FROM p_staff THEN RAISE EXCEPTION 'تغير حساب المستخدم'; END IF;
 IF u.role='owner' THEN RETURN; END IF;
 PERFORM public.engine_validate(u.store_id,u.tenant_id,ARRAY['manager','employee']);
 INSERT INTO public.employee_attendance(user_id,store_id,attendance_date,status) VALUES(u.id,u.store_id,(now() AT TIME ZONE 'Africa/Algiers')::date,'present') ON CONFLICT(user_id,attendance_date) DO NOTHING;
END $$;
CREATE FUNCTION public.engine_sale_attendance() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM public.users u JOIN public.stores s ON s.tenant_id=u.tenant_id AND s.id=NEW.store_id WHERE u.id=NEW.user_id AND u.role IN ('manager','employee')) THEN
  INSERT INTO public.employee_attendance(user_id,store_id,attendance_date,status) VALUES(NEW.user_id,NEW.store_id,(coalesce(NEW.created_at,now()) AT TIME ZONE 'Africa/Algiers')::date,'present') ON CONFLICT(user_id,attendance_date) DO NOTHING;
 END IF; RETURN NEW;
END $$;
CREATE TRIGGER sale_attendance AFTER INSERT ON public.sales FOR EACH ROW EXECUTE FUNCTION public.engine_sale_attendance();
REVOKE ALL ON FUNCTION public.engine_register_employee_hr(uuid,text,text,uuid,text,text,text,integer,numeric),public.engine_hr_overview(uuid),public.engine_payslip(uuid),public.engine_mark_attendance(uuid),public.engine_sale_attendance() FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.engine_register_employee_hr(uuid,text,text,uuid,text,text,text,integer,numeric),public.engine_hr_overview(uuid),public.engine_payslip(uuid),public.engine_mark_attendance(uuid) TO authenticated;
