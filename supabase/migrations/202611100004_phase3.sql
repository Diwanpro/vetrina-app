-- Intentionally NO ENABLE/DISABLE RLS or policy changes in this migration.
CREATE OR REPLACE FUNCTION public.engine_session() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public AS $$
DECLARE u public.users; result jsonb;
BEGIN
 SELECT * INTO u FROM public.current_staff();
 IF u.id IS NULL THEN RAISE EXCEPTION 'لا يوجد ملف موظف نشط'; END IF;
 SELECT jsonb_build_object('staffId',u.id,'role',u.role,'tenantId',u.tenant_id,'assignedStoreId',u.store_id,
 'tenant',(SELECT jsonb_build_object('id',id,'name',name,'is_active',is_active,'subscription_end_date',subscription_end_date) FROM public.tenants WHERE id=u.tenant_id),
 'stores',coalesce((SELECT jsonb_agg(jsonb_build_object('id',id,'name',name) ORDER BY created_at,id) FROM public.stores WHERE tenant_id=u.tenant_id AND (u.role='owner' OR id=u.store_id)),'[]'::jsonb)) INTO result;
 RETURN result;
END $$;
CREATE OR REPLACE FUNCTION public.engine_validate(p_store uuid,p_tenant uuid,p_roles text[]) RETURNS uuid
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public AS $$
DECLARE u public.users;
BEGIN
 SELECT * INTO u FROM public.current_staff();
 IF u.id IS NULL OR u.tenant_id IS DISTINCT FROM p_tenant OR NOT(u.role=ANY(p_roles))
 OR (u.role<>'owner' AND (u.store_id IS NULL OR u.store_id IS DISTINCT FROM p_store))
 OR NOT EXISTS(SELECT 1 FROM public.stores WHERE id=p_store AND tenant_id=p_tenant) THEN RAISE EXCEPTION 'غير مصرح لهذا الفرع'; END IF;
 IF EXISTS(SELECT 1 FROM public.tenants WHERE id=p_tenant AND is_active=false AND subscription_end_date<now()) THEN RAISE EXCEPTION 'انتهى الاشتراك. يرجى التفعيل'; END IF;
 RETURN u.id;
END $$;
CREATE OR REPLACE FUNCTION public.engine_staff(p_store uuid,p_tenant uuid) RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public AS $$ SELECT public.engine_validate(p_store,p_tenant,ARRAY['owner','manager']); $$;
CREATE OR REPLACE FUNCTION public.engine_activate(p_key text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE u public.users;
BEGIN
 SELECT * INTO u FROM public.current_staff();
 IF u.id IS NULL OR u.role<>'owner' THEN RAISE EXCEPTION 'التفعيل متاح للمالك فقط'; END IF;
 IF p_key IS DISTINCT FROM 'VETRINA-LIFETIME' THEN RAISE EXCEPTION 'مفتاح التفعيل غير صحيح'; END IF;
 UPDATE public.tenants SET is_active=true,is_activated=true,subscription_plan='lifetime' WHERE id=u.tenant_id;
END $$;
CREATE OR REPLACE FUNCTION public.engine_add_store(p_name text,p_address text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE u public.users; result uuid;
BEGIN
 SELECT * INTO u FROM public.current_staff();
 IF u.id IS NULL OR u.role<>'owner' THEN RAISE EXCEPTION 'إضافة الفروع متاحة للمالك فقط'; END IF;
 IF EXISTS(SELECT 1 FROM public.tenants WHERE id=u.tenant_id AND is_active=false AND subscription_end_date<now()) THEN RAISE EXCEPTION 'انتهى الاشتراك'; END IF;
 IF nullif(trim(p_name),'') IS NULL OR length(p_name)>200 THEN RAISE EXCEPTION 'اسم الفرع مطلوب (حتى 200 حرف)'; END IF;
 INSERT INTO public.stores(tenant_id,name,address) VALUES(u.tenant_id,trim(p_name),nullif(trim(p_address),'')) RETURNING id INTO result;
 RETURN result;
END $$;
ALTER TABLE public.sales ADD COLUMN IF NOT EXISTS sync_items jsonb;
CREATE UNIQUE INDEX IF NOT EXISTS sales_store_local_id ON public.sales(store_id,local_id) WHERE local_id IS NOT NULL;
CREATE OR REPLACE FUNCTION public.engine_sync_sale(p_store uuid,p_tenant uuid,p_local_id text,p_items jsonb,p_payment text,p_created_at timestamptz) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE staff uuid; previous public.sales; result uuid; item record; stock integer; floor_price numeric; total numeric;
BEGIN
 staff:=public.engine_validate(p_store,p_tenant,ARRAY['owner','manager','employee']);
 IF nullif(p_local_id,'') IS NULL OR length(p_local_id)>100 OR p_payment IS NULL OR p_payment NOT IN('cash','check','ccp') OR p_created_at IS NULL OR p_created_at>now()+interval '5 minutes' THEN RAISE EXCEPTION 'بيانات الفاتورة غير صالحة'; END IF;
 IF jsonb_typeof(p_items) IS DISTINCT FROM 'array' OR jsonb_array_length(p_items)=0 OR jsonb_array_length(p_items)>200 THEN RAISE EXCEPTION 'بنود الفاتورة غير صالحة'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(p_store::text||p_local_id,0));
 SELECT * INTO previous FROM public.sales WHERE store_id=p_store AND local_id=p_local_id;
 IF FOUND THEN
  IF previous.user_id IS DISTINCT FROM staff OR previous.sync_items IS DISTINCT FROM p_items OR previous.payment_method IS DISTINCT FROM p_payment THEN RAISE EXCEPTION 'معرّف محلي مكرر ببيانات مختلفة'; END IF;
  RETURN previous.id;
 END IF;
 IF EXISTS(SELECT 1 FROM jsonb_to_recordset(p_items) AS x(variant_id uuid,quantity numeric,final_price numeric,original_price numeric) WHERE variant_id IS NULL OR quantity IS NULL OR quantity<=0 OR quantity<>trunc(quantity) OR quantity>2147483647 OR final_price IS NULL OR final_price<0 OR final_price<>trunc(final_price) OR final_price>2147483647 OR original_price IS NULL OR original_price<0 OR original_price<>trunc(original_price) OR original_price>2147483647) THEN RAISE EXCEPTION 'كميات أو أسعار غير صالحة'; END IF;
 IF (SELECT count(*) FROM jsonb_to_recordset(p_items) AS x(variant_id uuid))<>(SELECT count(DISTINCT variant_id) FROM jsonb_to_recordset(p_items) AS x(variant_id uuid)) THEN RAISE EXCEPTION 'مقاس مكرر'; END IF;
 SELECT sum(quantity*final_price) INTO total FROM jsonb_to_recordset(p_items) AS x(quantity numeric,final_price numeric);
 IF total>2147483647 THEN RAISE EXCEPTION 'إجمالي كبير جداً'; END IF;
 INSERT INTO public.sales(store_id,user_id,total_amount,payment_method,status,local_id,synced_at,created_at,sync_items) VALUES(p_store,staff,total,p_payment,'completed',p_local_id,now(),p_created_at,p_items) RETURNING id INTO result;
 FOR item IN SELECT * FROM jsonb_to_recordset(p_items) AS x(variant_id uuid,quantity integer,final_price integer,original_price integer) ORDER BY variant_id LOOP
  SELECT coalesce(v.min_price,0) INTO floor_price FROM public.product_variants v JOIN public.products p ON p.id=v.product_id WHERE v.id=item.variant_id AND p.tenant_id=p_tenant AND p.is_active=true FOR UPDATE OF v;
  IF NOT FOUND OR item.final_price<floor_price THEN RAISE EXCEPTION 'مقاس غير متاح أو سعر أقل من الحد الأدنى. راجع الفاتورة المحلية'; END IF;
  SELECT quantity INTO stock FROM public.inventory WHERE variant_id=item.variant_id AND store_id=p_store FOR UPDATE;
  IF NOT FOUND OR stock<item.quantity THEN RAISE EXCEPTION 'المخزون غير كافٍ. راجع الفاتورة المحلية'; END IF;
  UPDATE public.inventory SET quantity=quantity-item.quantity,updated_at=now() WHERE variant_id=item.variant_id AND store_id=p_store;
  INSERT INTO public.sale_items(sale_id,variant_id,quantity,original_price,final_price,unit_price,subtotal) VALUES(result,item.variant_id,item.quantity,item.original_price,item.final_price,item.final_price,item.final_price::numeric*item.quantity);
 END LOOP;
 RETURN result;
END $$;
ALTER TABLE public.transfers ADD COLUMN IF NOT EXISTS tenant_id uuid REFERENCES public.tenants(id), ADD COLUMN IF NOT EXISTS request_id uuid;
CREATE UNIQUE INDEX IF NOT EXISTS transfers_request ON public.transfers(request_id);
CREATE OR REPLACE FUNCTION public.engine_transfer(p_from uuid,p_to uuid,p_tenant uuid,p_variant uuid,p_quantity integer,p_request uuid) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE staff uuid; result uuid; previous public.transfers; stock integer;
BEGIN
 staff:=public.engine_validate(p_from,p_tenant,ARRAY['owner']);
 PERFORM public.engine_validate(p_to,p_tenant,ARRAY['owner']);
 IF p_from=p_to OR p_quantity IS NULL OR p_quantity<=0 OR p_request IS NULL THEN RAISE EXCEPTION 'أدخل فرعين مختلفين وكمية موجبة'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(p_request::text,0));
 SELECT * INTO previous FROM public.transfers WHERE request_id=p_request;
 IF FOUND THEN
  IF previous.from_store_id IS DISTINCT FROM p_from OR previous.to_store_id IS DISTINCT FROM p_to OR previous.tenant_id IS DISTINCT FROM p_tenant OR NOT EXISTS(SELECT 1 FROM public.transfer_items WHERE transfer_id=previous.id AND variant_id=p_variant AND quantity=p_quantity) THEN RAISE EXCEPTION 'طلب نقل مكرر بقيم مختلفة'; END IF;
  RETURN previous.id;
 END IF;
 PERFORM v.id FROM public.product_variants v JOIN public.products p ON p.id=v.product_id WHERE v.id=p_variant AND p.tenant_id=p_tenant FOR UPDATE OF v;
 IF NOT FOUND THEN RAISE EXCEPTION 'المقاس لا ينتمي للمؤسسة'; END IF;
 PERFORM id FROM public.inventory WHERE variant_id=p_variant AND store_id IN(p_from,p_to) ORDER BY store_id FOR UPDATE;
 SELECT quantity INTO stock FROM public.inventory WHERE store_id=p_from AND variant_id=p_variant;
 IF NOT FOUND OR stock<p_quantity THEN RAISE EXCEPTION 'المخزون غير كافٍ للنقل'; END IF;
 INSERT INTO public.transfers(from_store_id,to_store_id,tenant_id,status,approved_by,request_id) VALUES(p_from,p_to,p_tenant,'completed',staff,p_request) RETURNING id INTO result;
 INSERT INTO public.transfer_items(transfer_id,variant_id,quantity) VALUES(result,p_variant,p_quantity);
 UPDATE public.inventory SET quantity=quantity-p_quantity,updated_at=now() WHERE store_id=p_from AND variant_id=p_variant;
 INSERT INTO public.inventory(store_id,variant_id,quantity) VALUES(p_to,p_variant,p_quantity) ON CONFLICT(store_id,variant_id) DO UPDATE SET quantity=inventory.quantity+excluded.quantity,updated_at=now();
 RETURN result;
END $$;
CREATE OR REPLACE FUNCTION public.engine_transfer_history() RETURNS SETOF public.transfers
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public AS $$
DECLARE u public.users;
BEGIN
 SELECT * INTO u FROM public.current_staff();
 IF u.id IS NULL OR u.role<>'owner' THEN RAISE EXCEPTION 'غير مصرح'; END IF;
 RETURN QUERY SELECT * FROM public.transfers WHERE tenant_id=u.tenant_id ORDER BY created_at DESC LIMIT 100;
END $$;
REVOKE ALL ON FUNCTION public.engine_session(),public.engine_validate(uuid,uuid,text[]),public.engine_activate(text),public.engine_add_store(text,text),public.engine_sync_sale(uuid,uuid,text,jsonb,text,timestamptz),public.engine_transfer(uuid,uuid,uuid,uuid,integer,uuid),public.engine_transfer_history() FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.engine_session(),public.engine_validate(uuid,uuid,text[]),public.engine_activate(text),public.engine_add_store(text,text),public.engine_sync_sale(uuid,uuid,text,jsonb,text,timestamptz),public.engine_transfer(uuid,uuid,uuid,uuid,integer,uuid),public.engine_transfer_history() TO authenticated;
CREATE OR REPLACE FUNCTION public.engine_sync_audit(p_store uuid,p_tenant uuid,p_id uuid,p_action text,p_details jsonb,p_device text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE staff uuid;
BEGIN
 staff:=public.engine_validate(p_store,p_tenant,ARRAY['owner','manager','employee']);
 IF p_id IS NULL OR nullif(p_action,'') IS NULL THEN RAISE EXCEPTION 'سجل غير صالح'; END IF;
 IF EXISTS(SELECT 1 FROM public.audit_log WHERE id=p_id AND (store_id IS DISTINCT FROM p_store OR user_id IS DISTINCT FROM staff)) THEN RAISE EXCEPTION 'سجل مكرر'; END IF;
 INSERT INTO public.audit_log(id,user_id,store_id,action,details,device_info) VALUES(p_id,staff,p_store,p_action,p_details,p_device) ON CONFLICT(id) DO NOTHING;
END $$;
REVOKE ALL ON FUNCTION public.engine_sync_audit(uuid,uuid,uuid,text,jsonb,text) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.engine_sync_audit(uuid,uuid,uuid,text,jsonb,text) TO authenticated;
-- Pin outbox authors explicitly, even if another account signs in mid-sync.
CREATE OR REPLACE FUNCTION public.engine_sync_sale_for_staff(p_store uuid,p_tenant uuid,p_local_id text,p_items jsonb,p_payment text,p_created_at timestamptz,p_staff uuid) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
BEGIN
 IF public.current_staff_id() IS DISTINCT FROM p_staff THEN RAISE EXCEPTION 'تغير المستخدم أثناء المزامنة'; END IF;
 RETURN public.engine_sync_sale(p_store,p_tenant,p_local_id,p_items,p_payment,p_created_at);
END $$;
CREATE OR REPLACE FUNCTION public.engine_sync_audit_for_staff(p_store uuid,p_tenant uuid,p_id uuid,p_action text,p_details jsonb,p_device text,p_staff uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
BEGIN
 IF public.current_staff_id() IS DISTINCT FROM p_staff THEN RAISE EXCEPTION 'تغير المستخدم أثناء المزامنة'; END IF;
 PERFORM public.engine_sync_audit(p_store,p_tenant,p_id,p_action,p_details,p_device);
END $$;
REVOKE ALL ON FUNCTION public.engine_sync_sale_for_staff(uuid,uuid,text,jsonb,text,timestamptz,uuid),public.engine_sync_audit_for_staff(uuid,uuid,uuid,text,jsonb,text,uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.engine_sync_sale_for_staff(uuid,uuid,text,jsonb,text,timestamptz,uuid),public.engine_sync_audit_for_staff(uuid,uuid,uuid,text,jsonb,text,uuid) TO authenticated;
-- Preserve existing financial RLS policies while supporting owners whose staff
-- profile has a home store. Returned financial rows remain strictly branch-scoped.
CREATE OR REPLACE FUNCTION public.engine_suppliers(p_store uuid,p_tenant uuid) RETURNS SETOF public.suppliers
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public AS $$
BEGIN
 PERFORM public.engine_staff(p_store,p_tenant);
 RETURN QUERY SELECT * FROM public.suppliers WHERE store_id=p_store AND tenant_id=p_tenant;
END $$;
CREATE OR REPLACE FUNCTION public.engine_purchases(p_store uuid,p_tenant uuid) RETURNS SETOF public.purchases
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public AS $$
BEGIN
 PERFORM public.engine_staff(p_store,p_tenant);
 RETURN QUERY SELECT * FROM public.purchases WHERE store_id=p_store AND tenant_id=p_tenant;
END $$;
REVOKE ALL ON FUNCTION public.engine_suppliers(uuid,uuid),public.engine_purchases(uuid,uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.engine_suppliers(uuid,uuid),public.engine_purchases(uuid,uuid) TO authenticated;
