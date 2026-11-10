-- Scope new financial records explicitly. Preserve historical rows without
-- guessing which store an unscoped supplier belonged to.
ALTER TABLE public.suppliers ADD COLUMN IF NOT EXISTS store_id uuid REFERENCES public.stores(id);
ALTER TABLE public.supplier_payments ADD COLUMN IF NOT EXISTS store_id uuid REFERENCES public.stores(id), ADD COLUMN IF NOT EXISTS tenant_id uuid REFERENCES public.tenants(id), ADD COLUMN IF NOT EXISTS request_id uuid;
ALTER TABLE public.purchases ADD COLUMN IF NOT EXISTS tenant_id uuid REFERENCES public.tenants(id), ADD COLUMN IF NOT EXISTS supplier_id uuid REFERENCES public.suppliers(id), ADD COLUMN IF NOT EXISTS request_id uuid, ADD COLUMN IF NOT EXISTS request_items jsonb;
ALTER TABLE public.purchase_items ADD COLUMN IF NOT EXISTS tenant_id uuid REFERENCES public.tenants(id), ADD COLUMN IF NOT EXISTS store_id uuid REFERENCES public.stores(id);
-- Average costs must retain fractions rather than round after each receipt.
ALTER TABLE public.product_variants ALTER COLUMN cost_price_avg TYPE numeric USING cost_price_avg::numeric;
CREATE UNIQUE INDEX IF NOT EXISTS purchases_request_id ON public.purchases(request_id);
CREATE UNIQUE INDEX IF NOT EXISTS supplier_payments_request_id ON public.supplier_payments(request_id);

CREATE OR REPLACE FUNCTION public.engine_staff(p_store uuid, p_tenant uuid) RETURNS uuid
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE u public.users;
BEGIN
  SELECT * INTO u FROM public.current_staff();
  IF u.id IS NULL OR u.tenant_id IS DISTINCT FROM p_tenant
    OR u.role NOT IN ('owner','manager') OR (u.store_id IS NULL AND u.role <> 'owner')
    OR (u.store_id IS NOT NULL AND u.store_id IS DISTINCT FROM p_store)
    OR NOT EXISTS (SELECT 1 FROM public.stores WHERE id=p_store AND tenant_id=p_tenant)
  THEN RAISE EXCEPTION 'غير مصرح لك بإدارة الموردين والمشتريات في هذا المتجر'; END IF;
  RETURN u.id;
END $$;
REVOKE ALL ON FUNCTION public.engine_staff(uuid,uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.engine_staff(uuid,uuid) TO authenticated;

ALTER TABLE public.suppliers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.supplier_payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.purchases ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.purchase_items ENABLE ROW LEVEL SECURITY;
-- Financial writes are only exposed through the validated, atomic RPCs below.
REVOKE INSERT, UPDATE, DELETE ON public.suppliers, public.supplier_payments, public.purchases, public.purchase_items FROM anon, authenticated;
GRANT SELECT ON public.suppliers, public.supplier_payments, public.purchases, public.purchase_items TO authenticated;
CREATE POLICY engine_suppliers_read ON public.suppliers FOR SELECT TO authenticated USING (EXISTS (SELECT 1 FROM public.current_staff() u WHERE u.tenant_id=suppliers.tenant_id AND u.role IN ('owner','manager') AND (u.store_id=suppliers.store_id OR (u.store_id IS NULL AND u.role='owner'))));
CREATE POLICY engine_payments_read ON public.supplier_payments FOR SELECT TO authenticated USING (EXISTS (SELECT 1 FROM public.current_staff() u WHERE u.tenant_id=supplier_payments.tenant_id AND u.role IN ('owner','manager') AND (u.store_id=supplier_payments.store_id OR (u.store_id IS NULL AND u.role='owner'))));
CREATE POLICY engine_purchases_read ON public.purchases FOR SELECT TO authenticated USING (EXISTS (SELECT 1 FROM public.current_staff() u WHERE u.tenant_id=purchases.tenant_id AND u.role IN ('owner','manager') AND (u.store_id=purchases.store_id OR (u.store_id IS NULL AND u.role='owner'))));
CREATE POLICY engine_items_read ON public.purchase_items FOR SELECT TO authenticated USING (EXISTS (SELECT 1 FROM public.current_staff() u WHERE u.tenant_id=purchase_items.tenant_id AND u.role IN ('owner','manager') AND (u.store_id=purchase_items.store_id OR (u.store_id IS NULL AND u.role='owner'))));

CREATE OR REPLACE FUNCTION public.engine_add_supplier(p_store uuid,p_tenant uuid,p_name text,p_phone text,p_goods text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE result uuid;
BEGIN
  PERFORM public.engine_staff(p_store,p_tenant);
  IF nullif(trim(p_name),'') IS NULL THEN RAISE EXCEPTION 'اسم المورد مطلوب'; END IF;
  INSERT INTO public.suppliers(store_id,tenant_id,name,phone,supplied_goods,total_debt)
    VALUES(p_store,p_tenant,trim(p_name),nullif(trim(p_phone),''),nullif(trim(p_goods),''),0) RETURNING id INTO result;
  RETURN result;
END $$;

CREATE OR REPLACE FUNCTION public.engine_pay_supplier(p_store uuid,p_tenant uuid,p_supplier uuid,p_amount integer,p_request uuid) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE staff uuid; debt bigint; result uuid; previous public.supplier_payments;
BEGIN
  staff := public.engine_staff(p_store,p_tenant);
  IF p_amount IS NULL OR p_amount<=0 OR p_request IS NULL THEN RAISE EXCEPTION 'مبلغ الدفع غير صالح'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(p_request::text,0));
  SELECT * INTO previous FROM public.supplier_payments WHERE request_id=p_request;
  IF FOUND THEN
    IF previous.store_id IS DISTINCT FROM p_store OR previous.tenant_id IS DISTINCT FROM p_tenant OR previous.supplier_id IS DISTINCT FROM p_supplier OR previous.amount IS DISTINCT FROM p_amount THEN RAISE EXCEPTION 'طلب دفع مكرر بقيم مختلفة'; END IF;
    RETURN previous.id;
  END IF;
  SELECT coalesce(total_debt,0) INTO debt FROM public.suppliers WHERE id=p_supplier AND tenant_id=p_tenant AND store_id=p_store FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'المورد غير موجود في هذا المتجر'; END IF;
  IF p_amount>debt THEN RAISE EXCEPTION 'الدفعة أكبر من الدين المتبقي'; END IF;
  INSERT INTO public.supplier_payments(supplier_id,store_id,tenant_id,amount,paid_by,request_id)
    VALUES(p_supplier,p_store,p_tenant,p_amount,staff,p_request) RETURNING id INTO result;
  UPDATE public.suppliers SET total_debt=debt-p_amount WHERE id=p_supplier;
  RETURN result;
END $$;

CREATE OR REPLACE FUNCTION public.engine_receive_purchase(p_store uuid,p_tenant uuid,p_supplier uuid,p_items jsonb,p_request uuid) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE staff uuid; supplier public.suppliers; result uuid; previous public.purchases; item record;
  old_qty bigint; old_cost numeric; total numeric; amount numeric;
BEGIN
  staff := public.engine_staff(p_store,p_tenant);
  IF p_request IS NULL OR jsonb_typeof(p_items) IS DISTINCT FROM 'array' OR jsonb_array_length(p_items)=0 OR jsonb_array_length(p_items)>200 THEN RAISE EXCEPTION 'أضف بنود فاتورة صالحة (حتى 200 بند)'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(p_request::text,0));
  SELECT * INTO previous FROM public.purchases WHERE request_id=p_request;
  IF FOUND THEN
    IF previous.store_id IS DISTINCT FROM p_store OR previous.tenant_id IS DISTINCT FROM p_tenant OR previous.supplier_id IS DISTINCT FROM p_supplier OR previous.request_items IS DISTINCT FROM p_items THEN RAISE EXCEPTION 'طلب شراء مكرر بقيم مختلفة'; END IF;
    RETURN previous.id;
  END IF;
  -- Serialize receipts per tenant; also lock variant and stock rows against updates.
  PERFORM pg_advisory_xact_lock(hashtextextended(p_tenant::text,1));
  SELECT * INTO supplier FROM public.suppliers WHERE id=p_supplier AND tenant_id=p_tenant AND store_id=p_store FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'المورد غير موجود في هذا المتجر'; END IF;
  IF EXISTS (SELECT 1 FROM jsonb_to_recordset(p_items) AS x(variant_id uuid,quantity numeric,unit_cost numeric)
    WHERE variant_id IS NULL OR quantity IS NULL OR quantity<=0 OR quantity<>trunc(quantity) OR quantity>2147483647 OR unit_cost IS NULL OR unit_cost<0 OR unit_cost<>trunc(unit_cost) OR unit_cost>2147483647)
    THEN RAISE EXCEPTION 'الكميات والتكاليف يجب أن تكون أعداداً صحيحة صالحة'; END IF;
  IF (SELECT count(*) FROM jsonb_to_recordset(p_items) AS x(variant_id uuid)) <> (SELECT count(DISTINCT variant_id) FROM jsonb_to_recordset(p_items) AS x(variant_id uuid)) THEN RAISE EXCEPTION 'لا تكرر نفس المقاس في الفاتورة'; END IF;
  SELECT sum(quantity*unit_cost) INTO total FROM jsonb_to_recordset(p_items) AS x(quantity numeric,unit_cost numeric);
  IF total>2147483647 OR coalesce(supplier.total_debt,0)::numeric+total>2147483647 THEN RAISE EXCEPTION 'إجمالي الفاتورة أو الدين كبير جداً'; END IF;
  INSERT INTO public.purchases(store_id,tenant_id,supplier_id,supplier_name,total_amount,status,created_by,request_id,request_items)
    VALUES(p_store,p_tenant,p_supplier,supplier.name,total,'received',staff,p_request,p_items) RETURNING id INTO result;
  FOR item IN SELECT * FROM jsonb_to_recordset(p_items) AS x(variant_id uuid,quantity integer,unit_cost integer) ORDER BY variant_id LOOP
    SELECT v.cost_price_avg INTO old_cost FROM public.product_variants v JOIN public.products p ON p.id=v.product_id
      WHERE v.id=item.variant_id AND p.tenant_id=p_tenant FOR UPDATE OF v;
    IF NOT FOUND THEN RAISE EXCEPTION 'المقاس لا ينتمي إلى المؤسسة'; END IF;
    PERFORM i.id FROM public.inventory i WHERE i.variant_id=item.variant_id FOR UPDATE;
    -- cost_price_avg is shared by the variant: weight all stock in this tenant,
    -- not only the receiving store's stock.
    SELECT coalesce(sum(i.quantity),0) INTO old_qty FROM public.inventory i JOIN public.stores s ON s.id=i.store_id WHERE i.variant_id=item.variant_id AND s.tenant_id=p_tenant;
    IF old_qty<0 THEN RAISE EXCEPTION 'لا يمكن حساب التكلفة لمخزون سالب'; END IF;
    amount := ((old_qty*coalesce(old_cost,0))+(item.quantity::numeric*item.unit_cost))/(old_qty+item.quantity);
    UPDATE public.product_variants SET cost_price_avg=amount WHERE id=item.variant_id;
    INSERT INTO public.purchase_items(purchase_id,variant_id,quantity,unit_cost,tenant_id,store_id)
      VALUES(result,item.variant_id,item.quantity,item.unit_cost,p_tenant,p_store);
    INSERT INTO public.inventory(store_id,variant_id,quantity) VALUES(p_store,item.variant_id,item.quantity)
      ON CONFLICT(store_id,variant_id) DO UPDATE SET quantity=inventory.quantity+excluded.quantity,updated_at=now();
  END LOOP;
  UPDATE public.suppliers SET total_debt=coalesce(total_debt,0)+total WHERE id=p_supplier;
  RETURN result;
END $$;
REVOKE ALL ON FUNCTION public.engine_add_supplier(uuid,uuid,text,text,text), public.engine_pay_supplier(uuid,uuid,uuid,integer,uuid), public.engine_receive_purchase(uuid,uuid,uuid,jsonb,uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.engine_add_supplier(uuid,uuid,text,text,text), public.engine_pay_supplier(uuid,uuid,uuid,integer,uuid), public.engine_receive_purchase(uuid,uuid,uuid,jsonb,uuid) TO authenticated;
