-- Preserve all existing RLS flags/policies. All new entry points validate current staff.
CREATE OR REPLACE FUNCTION public.engine_activate(p_key text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE u public.users;
BEGIN
 SELECT * INTO u FROM public.current_staff();
 IF u.id IS NULL OR u.role<>'owner' THEN RAISE EXCEPTION 'التفعيل متاح للمالك فقط'; END IF;
 IF trim(p_key) IS DISTINCT FROM 'VETRINA-LIFETIME' THEN RAISE EXCEPTION 'مفتاح التفعيل غير صحيح'; END IF;
 UPDATE public.tenants SET is_active=true,is_activated=true,subscription_plan='lifetime',subscription_end_date=null WHERE id=u.tenant_id;
END $$;

ALTER TABLE public.employee_advances ADD COLUMN IF NOT EXISTS store_id uuid REFERENCES public.stores(id), ADD COLUMN IF NOT EXISTS request_id uuid;
ALTER TABLE public.employee_payroll ADD COLUMN IF NOT EXISTS store_id uuid REFERENCES public.stores(id), ADD COLUMN IF NOT EXISTS request_id uuid;
ALTER TABLE public.shifts ADD COLUMN IF NOT EXISTS total_employee_payments bigint NOT NULL DEFAULT 0;
CREATE UNIQUE INDEX IF NOT EXISTS employee_advances_request ON public.employee_advances(request_id);
CREATE UNIQUE INDEX IF NOT EXISTS employee_payroll_request ON public.employee_payroll(request_id);

CREATE OR REPLACE FUNCTION public.engine_employees(p_store uuid DEFAULT null) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public AS $$
DECLARE u public.users;
BEGIN
 SELECT * INTO u FROM public.current_staff();
 IF u.id IS NULL OR u.role<>'owner' THEN RAISE EXCEPTION 'للمالك فقط'; END IF;
 IF p_store IS NOT NULL THEN PERFORM public.engine_validate(p_store,u.tenant_id,ARRAY['owner']); END IF;
 RETURN coalesce((SELECT jsonb_agg(jsonb_build_object('id',id,'username',username,'role',role,'store_id',store_id,'is_active',is_active) ORDER BY username,id) FROM public.users WHERE tenant_id=u.tenant_id AND role IN ('manager','employee') AND (p_store IS NULL OR store_id=p_store)), '[]'::jsonb);
END $$;

-- Only attaches Auth accounts created by this owner's privileged Edge Function.
CREATE OR REPLACE FUNCTION public.engine_register_employee(p_auth uuid,p_username text,p_role text,p_store uuid) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE u public.users; result uuid;
BEGIN
 SELECT * INTO u FROM public.current_staff();
 PERFORM public.engine_validate(p_store,u.tenant_id,ARRAY['owner']);
 IF p_username !~ '^[a-z0-9_]{3,40}$' OR p_role IS NULL OR p_role NOT IN ('manager','employee') THEN RAISE EXCEPTION 'بيانات الموظف غير صالحة'; END IF;
 IF NOT EXISTS(SELECT 1 FROM auth.users WHERE id=p_auth AND email=p_username||'@staff.vetrina.dz' AND raw_app_meta_data->>'created_by_owner'=auth.uid()::text) THEN RAISE EXCEPTION 'حساب الدخول غير صالح'; END IF;
 INSERT INTO public.users(auth_id,tenant_id,store_id,username,role,is_active) VALUES(p_auth,u.tenant_id,p_store,p_username,p_role,true) RETURNING id INTO result;
 RETURN result;
END $$;

CREATE OR REPLACE FUNCTION public.engine_employee_payment(p_user uuid,p_kind text,p_amount integer,p_detail text,p_request uuid) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE u public.users; employee public.users; s public.shifts; result uuid; old_record record;
BEGIN
 SELECT * INTO u FROM public.current_staff();
 SELECT * INTO employee FROM public.users WHERE id=p_user AND tenant_id=u.tenant_id AND role IN ('manager','employee') FOR UPDATE;
 IF employee.id IS NULL THEN RAISE EXCEPTION 'الموظف غير متاح'; END IF;
 PERFORM public.engine_validate(employee.store_id,u.tenant_id,ARRAY['owner']);
 IF p_amount IS NULL OR p_amount<=0 OR p_request IS NULL OR p_kind IS NULL OR p_kind NOT IN ('advance','payroll') OR nullif(trim(p_detail),'') IS NULL OR length(p_detail)>500 THEN RAISE EXCEPTION 'أدخل مبلغاً موجباً وتفاصيل صحيحة'; END IF;
 IF p_kind='payroll' AND p_detail !~ '^[0-9]{4}-(0[1-9]|1[0-2])$' THEN RAISE EXCEPTION 'الشهر غير صالح'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(p_request::text,0));
 IF p_kind='advance' THEN
  SELECT id,user_id,amount AS amount,reason AS detail INTO old_record FROM public.employee_advances WHERE request_id=p_request;
 ELSE
  SELECT id,user_id,amount_paid AS amount,month AS detail INTO old_record FROM public.employee_payroll WHERE request_id=p_request;
 END IF;
 IF old_record.id IS NOT NULL THEN
  IF old_record.user_id<>p_user OR old_record.amount<>p_amount OR old_record.detail<>p_detail THEN RAISE EXCEPTION 'طلب مكرر ببيانات مختلفة'; END IF;
  RETURN old_record.id;
 END IF;
 SELECT * INTO s FROM public.shifts WHERE store_id=employee.store_id AND status='open' FOR UPDATE;
 IF s.id IS NULL THEN RAISE EXCEPTION 'افتح صندوق فرع الموظف قبل الدفع'; END IF;
 IF p_kind='advance' THEN
  INSERT INTO public.employee_advances(user_id,amount,reason,store_id,request_id) VALUES(p_user,p_amount,p_detail,employee.store_id,p_request) RETURNING id INTO result;
 ELSE
  INSERT INTO public.employee_payroll(user_id,amount_paid,month,store_id,request_id) VALUES(p_user,p_amount,p_detail,employee.store_id,p_request) RETURNING id INTO result;
 END IF;
 UPDATE public.shifts SET total_employee_payments=total_employee_payments+p_amount WHERE id=s.id;
 RETURN result;
END $$;

CREATE OR REPLACE FUNCTION public.engine_close_shift(p_shift uuid,p_actual integer,p_expected bigint,p_difference bigint,p_notes text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE u public.users; s public.shifts; sales bigint; expected bigint;
BEGIN
 SELECT * INTO u FROM public.current_staff();
 SELECT * INTO s FROM public.shifts WHERE id=p_shift FOR UPDATE;
 PERFORM public.engine_validate(s.store_id,u.tenant_id,ARRAY['owner','manager','employee']);
 IF s.id IS NULL OR s.status<>'open' THEN RAISE EXCEPTION 'الوردية مغلقة'; END IF;
 SELECT coalesce(sum(total_amount),0) INTO sales FROM public.sales WHERE store_id=s.store_id AND payment_method='cash' AND status='completed' AND created_at>=s.start_time AND created_at<now();
 expected:=s.expected_cash::bigint+sales-s.total_employee_payments;
 IF p_actual IS NULL OR p_actual<0 OR p_expected IS DISTINCT FROM expected OR p_difference IS DISTINCT FROM p_actual::bigint-expected THEN RAISE EXCEPTION 'تغير الصندوق. أعد فتح التقفيلة وراجع النقد المتوقع'; END IF;
 IF p_difference<>0 AND nullif(trim(p_notes),'') IS NULL THEN RAISE EXCEPTION 'يجب توضيح سبب الفرق'; END IF;
 UPDATE public.shifts SET expected_cash=expected,actual_cash=p_actual,difference=p_difference,total_cash_sales=sales,notes=p_notes,status='closed',end_time=now(),closed_at=now() WHERE id=s.id;
END $$;

CREATE OR REPLACE FUNCTION public.engine_accounting(p_store uuid,p_from timestamptz,p_to timestamptz) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public AS $$
DECLARE u public.users; sales bigint; expenses bigint; salaries bigint; advances bigint; suppliers bigint;
BEGIN
 SELECT * INTO u FROM public.current_staff();
 IF u.id IS NULL OR u.role<>'owner' THEN RAISE EXCEPTION 'للمالك فقط'; END IF;
 IF p_store IS NOT NULL THEN PERFORM public.engine_validate(p_store,u.tenant_id,ARRAY['owner']); END IF;
 IF p_to IS NULL OR (p_from IS NOT NULL AND p_from>=p_to) THEN RAISE EXCEPTION 'الفترة غير صالحة'; END IF;
 SELECT coalesce(sum(x.total_amount),0) INTO sales FROM public.sales x JOIN public.stores s ON s.id=x.store_id WHERE s.tenant_id=u.tenant_id AND (p_store IS NULL OR s.id=p_store) AND x.status='completed' AND (p_from IS NULL OR x.created_at>=p_from) AND x.created_at<p_to;
 SELECT coalesce(sum(x.amount),0) INTO expenses FROM public.expenses x JOIN public.stores s ON s.id=x.store_id WHERE s.tenant_id=u.tenant_id AND (p_store IS NULL OR s.id=p_store) AND (p_from IS NULL OR x.created_at>=p_from) AND x.created_at<p_to;
 -- Snapshot store on new payments; legacy rows fall back to employee assignment.
 SELECT coalesce(sum(x.amount_paid),0) INTO salaries FROM public.employee_payroll x JOIN public.users e ON e.id=x.user_id LEFT JOIN public.stores s ON s.id=coalesce(x.store_id,e.store_id) WHERE e.tenant_id=u.tenant_id AND (p_store IS NULL OR s.id=p_store) AND (p_from IS NULL OR x.created_at>=p_from) AND x.created_at<p_to;
 SELECT coalesce(sum(x.amount),0) INTO advances FROM public.employee_advances x JOIN public.users e ON e.id=x.user_id LEFT JOIN public.stores s ON s.id=coalesce(x.store_id,e.store_id) WHERE e.tenant_id=u.tenant_id AND (p_store IS NULL OR s.id=p_store) AND (p_from IS NULL OR x.created_at>=p_from) AND x.created_at<p_to;
 SELECT coalesce(sum(x.amount),0) INTO suppliers FROM public.supplier_payments x JOIN public.stores s ON s.id=x.store_id WHERE s.tenant_id=u.tenant_id AND (p_store IS NULL OR s.id=p_store) AND (p_from IS NULL OR x.created_at>=p_from) AND x.created_at<p_to;
 RETURN jsonb_build_object('sales',sales,'expenses',expenses,'salaries',salaries,'advances',advances,'supplierPayments',suppliers,'netProfit',sales-expenses-salaries-advances);
END $$;
REVOKE ALL ON FUNCTION public.engine_employees(uuid),public.engine_register_employee(uuid,text,text,uuid),public.engine_employee_payment(uuid,text,integer,text,uuid),public.engine_close_shift(uuid,integer,bigint,bigint,text),public.engine_accounting(uuid,timestamptz,timestamptz) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.engine_employees(uuid),public.engine_register_employee(uuid,text,text,uuid),public.engine_employee_payment(uuid,text,integer,text,uuid),public.engine_close_shift(uuid,integer,bigint,bigint,text),public.engine_accounting(uuid,timestamptz,timestamptz) TO authenticated;
