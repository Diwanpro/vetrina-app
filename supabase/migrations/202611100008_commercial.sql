-- Existing application table RLS flags/policies are intentionally preserved.
CREATE TABLE public.license_redemptions(tenant_id uuid REFERENCES public.tenants(id) ON DELETE CASCADE, key_hash text, created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(tenant_id,key_hash));
REVOKE ALL ON public.license_redemptions FROM PUBLIC,anon,authenticated;
CREATE OR REPLACE FUNCTION public.engine_activate(p_key text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE u public.users; t public.tenants; parts text[]; n bigint;
BEGIN
 SELECT * INTO u FROM public.current_staff();
 IF u.id IS NULL OR u.role<>'owner' THEN RAISE EXCEPTION 'للمالك فقط'; END IF;
 SELECT * INTO t FROM public.tenants WHERE id=u.tenant_id FOR UPDATE;
 p_key:=trim(p_key);
 IF length(p_key)>200 THEN RAISE EXCEPTION 'المفتاح غير صالح'; END IF;
 parts:=regexp_match(p_key,'^(VTR|UPG)-([1-9][0-9]{0,9})-([A-Za-z0-9-]+)$');
 IF parts IS NULL THEN RAISE EXCEPTION 'استخدم VTR-X-... للتفعيل أو UPG-X-... للترقية'; END IF;
 n:=parts[2]::bigint;
 IF n>2147483647 THEN RAISE EXCEPTION 'حد الفروع غير صالح'; END IF;
 IF EXISTS(SELECT 1 FROM public.license_redemptions WHERE tenant_id=u.tenant_id AND key_hash=md5(p_key)) THEN RETURN; END IF;
 IF parts[1]='VTR' THEN
  IF t.is_active IS TRUE THEN RAISE EXCEPTION 'الحساب نشط. استخدم مفتاح ترقية'; END IF;
  IF n<(SELECT count(*) FROM public.stores WHERE tenant_id=u.tenant_id) THEN RAISE EXCEPTION 'المفتاح لا يغطي الفروع الحالية'; END IF;
  UPDATE public.tenants SET is_active=true,is_activated=true,subscription_end_date=null,branches_limit=n,subscription_plan='lifetime' WHERE id=u.tenant_id;
 ELSE
  IF t.is_active IS DISTINCT FROM true THEN RAISE EXCEPTION 'فعّل الحساب أولاً'; END IF;
  IF coalesce(t.branches_limit,0)::bigint+n>2147483647 THEN RAISE EXCEPTION 'تجاوز حد الفروع'; END IF;
  UPDATE public.tenants SET branches_limit=coalesce(branches_limit,0)+n WHERE id=u.tenant_id;
 END IF;
 INSERT INTO public.license_redemptions(tenant_id,key_hash) VALUES(u.tenant_id,md5(p_key));
END $$;
CREATE OR REPLACE FUNCTION public.engine_add_store(p_name text,p_address text) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE u public.users; t public.tenants; result uuid;
BEGIN
 SELECT * INTO u FROM public.current_staff();
 IF u.id IS NULL OR u.role<>'owner' THEN RAISE EXCEPTION 'للمالك فقط'; END IF;
 SELECT * INTO t FROM public.tenants WHERE id=u.tenant_id FOR UPDATE;
 IF t.is_active=false AND t.subscription_end_date<now() THEN RAISE EXCEPTION 'انتهى الاشتراك'; END IF;
 IF (SELECT count(*) FROM public.stores WHERE tenant_id=u.tenant_id)>=coalesce(t.branches_limit,0) THEN RAISE EXCEPTION 'وصلت إلى حد الفروع. يرجى ترقية الاشتراك'; END IF;
 IF nullif(trim(p_name),'') IS NULL OR length(p_name)>200 THEN RAISE EXCEPTION 'اسم الفرع غير صالح'; END IF;
 INSERT INTO public.stores(tenant_id,name,address) VALUES(u.tenant_id,trim(p_name),nullif(trim(p_address),'')) RETURNING id INTO result; RETURN result;
END $$;
-- Add the new limit to verified cached session metadata without changing its scope.
DO $$ DECLARE body text; BEGIN
 SELECT pg_get_functiondef('public.engine_session()'::regprocedure) INTO body;
 body:=replace(body,'''subscription_end_date'',subscription_end_date','''subscription_end_date'',subscription_end_date,''branches_limit'',branches_limit'); EXECUTE body;
END $$;
CREATE OR REPLACE FUNCTION public.engine_register_employee_hr(p_auth uuid,p_username text,p_role text,p_store uuid,p_first text,p_last text,p_salary_type text,p_salary_amount integer) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE result uuid;
BEGIN
 IF nullif(trim(p_first),'') IS NULL OR nullif(trim(p_last),'') IS NULL OR length(p_first)>100 OR length(p_last)>100 OR p_salary_type IS NULL OR p_salary_type NOT IN ('fixed','commission','daily') OR p_salary_amount IS NULL OR p_salary_amount<0 THEN RAISE EXCEPTION 'بيانات الموارد البشرية غير صالحة'; END IF;
 result:=public.engine_register_employee(p_auth,p_username,p_role,p_store);
 UPDATE public.users SET first_name=trim(p_first),last_name=trim(p_last),full_name=trim(p_first)||' '||trim(p_last),salary_type=p_salary_type,salary_amount=p_salary_amount WHERE id=result; RETURN result;
END $$;
CREATE OR REPLACE FUNCTION public.engine_employees(p_store uuid DEFAULT null) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public AS $$
DECLARE u public.users;
BEGIN
 SELECT * INTO u FROM public.current_staff(); IF u.id IS NULL OR u.role<>'owner' THEN RAISE EXCEPTION 'للمالك فقط'; END IF;
 IF p_store IS NOT NULL THEN PERFORM public.engine_validate(p_store,u.tenant_id,ARRAY['owner']); END IF;
 RETURN coalesce((SELECT jsonb_agg(jsonb_build_object('id',id,'username',username,'first_name',first_name,'last_name',last_name,'full_name',full_name,'salary_type',salary_type,'salary_amount',salary_amount,'role',role,'store_id',store_id,'is_active',is_active) ORDER BY username,id) FROM public.users WHERE tenant_id=u.tenant_id AND role IN ('manager','employee') AND (p_store IS NULL OR store_id=p_store)),'[]'::jsonb);
END $$;
REVOKE EXECUTE ON FUNCTION public.engine_register_employee(uuid,text,text,uuid) FROM authenticated;

ALTER TABLE public.expenses ADD COLUMN IF NOT EXISTS request_id uuid;
CREATE UNIQUE INDEX IF NOT EXISTS expense_request_unique ON public.expenses(request_id);
CREATE OR REPLACE FUNCTION public.engine_receipt_access(p_path text,p_write boolean) RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public AS $$
DECLARE u public.users; branch uuid;
BEGIN
 SELECT * INTO u FROM public.current_staff();
 IF u.id IS NULL OR split_part(p_path,'/',1)<>u.tenant_id::text THEN RETURN false; END IF;
 SELECT id INTO branch FROM public.stores WHERE id::text=split_part(p_path,'/',2) AND tenant_id=u.tenant_id;
 IF branch IS NULL OR (u.role<>'owner' AND u.store_id IS DISTINCT FROM branch) THEN RETURN false; END IF;
 IF p_write AND EXISTS(SELECT 1 FROM public.tenants WHERE id=u.tenant_id AND is_active=false AND subscription_end_date<now()) THEN RETURN false; END IF;
 RETURN (NOT p_write AND u.role='owner') OR split_part(p_path,'/',3)=auth.uid()::text;
END $$;
INSERT INTO storage.buckets(id,name,public,file_size_limit,allowed_mime_types) VALUES('expense-receipts','expense-receipts',false,5242880,ARRAY['image/jpeg','image/png','image/webp','application/pdf']) ON CONFLICT(id) DO NOTHING;
CREATE POLICY expense_receipt_insert ON storage.objects FOR INSERT TO authenticated WITH CHECK(bucket_id='expense-receipts' AND public.engine_receipt_access(name,true));
CREATE POLICY expense_receipt_read ON storage.objects FOR SELECT TO authenticated USING(bucket_id='expense-receipts' AND public.engine_receipt_access(name,false));
CREATE POLICY expense_receipt_cleanup ON storage.objects FOR DELETE TO authenticated USING(bucket_id='expense-receipts' AND public.engine_receipt_access(name,true) AND NOT EXISTS(SELECT 1 FROM public.expenses WHERE receipt_url=name));
CREATE OR REPLACE FUNCTION public.engine_record_expense(p_store uuid,p_amount integer,p_description text,p_receipt text,p_request uuid) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE u public.users; old public.expenses; result uuid;
BEGIN
 SELECT * INTO u FROM public.current_staff(); PERFORM public.engine_validate(p_store,u.tenant_id,ARRAY['owner','manager','employee']);
 IF p_amount IS NULL OR p_amount<=0 OR nullif(trim(p_description),'') IS NULL OR length(p_description)>1000 OR p_request IS NULL THEN RAISE EXCEPTION 'أدخل مبلغاً موجباً ووصفاً صحيحاً'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(p_request::text,0));
 SELECT * INTO old FROM public.expenses WHERE request_id=p_request;
 IF old.id IS NOT NULL THEN
  IF old.store_id<>p_store OR old.created_by<>u.id OR old.amount<>p_amount OR old.description IS DISTINCT FROM trim(p_description) OR old.receipt_url IS DISTINCT FROM p_receipt THEN RAISE EXCEPTION 'طلب مكرر ببيانات مختلفة'; END IF; RETURN old.id;
 END IF;
 IF p_receipt IS NOT NULL AND (NOT public.engine_receipt_access(p_receipt,true) OR split_part(p_receipt,'/',2)<>p_store::text OR NOT EXISTS(SELECT 1 FROM storage.objects WHERE bucket_id='expense-receipts' AND name=p_receipt)) THEN RAISE EXCEPTION 'المرفق غير صالح'; END IF;
 INSERT INTO public.expenses(store_id,amount,description,receipt_url,created_by,status,request_id) VALUES(p_store,p_amount,trim(p_description),p_receipt,u.id,'approved',p_request) RETURNING id INTO result; RETURN result;
END $$;
-- Snapshot costs on future sales. Legacy COGS remains explicitly estimated.
ALTER TABLE public.sale_items ADD COLUMN IF NOT EXISTS cost_at_sale numeric;
CREATE OR REPLACE FUNCTION public.engine_snapshot_cost() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
BEGIN
 SELECT coalesce(v.cost_price_avg,0) INTO NEW.cost_at_sale FROM public.product_variants v JOIN public.products p ON p.id=v.product_id JOIN public.sales sale ON sale.id=NEW.sale_id JOIN public.stores s ON s.id=sale.store_id WHERE v.id=NEW.variant_id AND p.tenant_id=s.tenant_id;
 RETURN NEW;
END $$;
CREATE TRIGGER snapshot_sale_cost BEFORE INSERT ON public.sale_items FOR EACH ROW EXECUTE FUNCTION public.engine_snapshot_cost();
CREATE OR REPLACE FUNCTION public.engine_accounting_commercial(p_store uuid,p_from timestamptz,p_to timestamptz) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public AS $$
DECLARE u public.users; result jsonb; cost numeric; estimated bigint;
BEGIN
 result:=public.engine_accounting(p_store,p_from,p_to); SELECT * INTO u FROM public.current_staff();
 SELECT coalesce(sum(i.quantity*coalesce(i.cost_at_sale,v.cost_price_avg,0)),0),count(*) FILTER(WHERE i.cost_at_sale IS NULL) INTO cost,estimated FROM public.sale_items i JOIN public.sales sale ON sale.id=i.sale_id JOIN public.stores s ON s.id=sale.store_id LEFT JOIN public.product_variants v ON v.id=i.variant_id WHERE s.tenant_id=u.tenant_id AND (p_store IS NULL OR s.id=p_store) AND sale.status='completed' AND (p_from IS NULL OR sale.created_at>=p_from) AND sale.created_at<p_to;
 RETURN result||jsonb_build_object('costOfGoods',cost,'estimatedCostItems',estimated,'netProfit',(result->>'netProfit')::numeric-cost);
END $$;
CREATE OR REPLACE FUNCTION public.engine_journal(p_store uuid,p_from timestamptz,p_to timestamptz,p_offset integer DEFAULT 0) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public AS $$
DECLARE u public.users; result jsonb;
BEGIN
 SELECT * INTO u FROM public.current_staff(); IF u.id IS NULL OR u.role<>'owner' THEN RAISE EXCEPTION 'للمالك فقط'; END IF;
 IF p_store IS NOT NULL THEN PERFORM public.engine_validate(p_store,u.tenant_id,ARRAY['owner']); END IF;
 IF p_offset IS NULL OR p_offset<0 OR p_to IS NULL OR (p_from IS NOT NULL AND p_from>=p_to) THEN RAISE EXCEPTION 'الفترة غير صالحة'; END IF;
 WITH entries AS (
 SELECT sale.id,sale.created_at,'sale'::text AS type,'فاتورة '||left(sale.id::text,8) AS details,sale.total_amount::numeric AS amount,null::text AS receipt,sale.store_id FROM public.sales sale JOIN public.stores s ON s.id=sale.store_id WHERE s.tenant_id=u.tenant_id AND sale.status='completed'
 UNION ALL SELECT x.id,x.created_at,'expense',x.description,x.amount,x.receipt_url,x.store_id FROM public.expenses x JOIN public.stores s ON s.id=x.store_id WHERE s.tenant_id=u.tenant_id
 UNION ALL SELECT x.id,x.created_at,'payroll',coalesce(e.full_name,e.username)||' · '||x.month,x.amount_paid,null,coalesce(x.store_id,e.store_id) FROM public.employee_payroll x JOIN public.users e ON e.id=x.user_id WHERE e.tenant_id=u.tenant_id
 UNION ALL SELECT x.id,x.created_at,'advance',coalesce(e.full_name,e.username)||' · '||coalesce(x.reason,''),x.amount,null,coalesce(x.store_id,e.store_id) FROM public.employee_advances x JOIN public.users e ON e.id=x.user_id WHERE e.tenant_id=u.tenant_id
 ), page AS (SELECT * FROM entries WHERE (p_store IS NULL OR store_id=p_store) AND (p_from IS NULL OR created_at>=p_from) AND created_at<p_to ORDER BY created_at DESC,type,id LIMIT 51 OFFSET p_offset)
 SELECT jsonb_build_object('rows',coalesce((SELECT jsonb_agg(to_jsonb(x) ORDER BY x.created_at DESC,x.type,x.id) FROM (SELECT * FROM page ORDER BY created_at DESC,type,id LIMIT 50) x),'[]'::jsonb),'hasMore',(SELECT count(*)>50 FROM page)) INTO result; RETURN result;
END $$;
REVOKE ALL ON FUNCTION public.engine_register_employee_hr(uuid,text,text,uuid,text,text,text,integer),public.engine_receipt_access(text,boolean),public.engine_record_expense(uuid,integer,text,text,uuid),public.engine_snapshot_cost(),public.engine_accounting_commercial(uuid,timestamptz,timestamptz),public.engine_journal(uuid,timestamptz,timestamptz,integer) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.engine_register_employee_hr(uuid,text,text,uuid,text,text,text,integer),public.engine_receipt_access(text,boolean),public.engine_record_expense(uuid,integer,text,text,uuid),public.engine_accounting_commercial(uuid,timestamptz,timestamptz),public.engine_journal(uuid,timestamptz,timestamptz,integer) TO authenticated;
