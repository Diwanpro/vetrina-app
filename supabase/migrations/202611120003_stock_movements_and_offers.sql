-- Manual stock addition, simple offers, and the sale-line support they need.
--
-- House rules followed: RLS on, no direct table grants, access only through
-- validated SECURITY DEFINER RPCs (see 202611100022).
--
-- The offers table already exists (created by hand): it has id, tenant_id,
-- is_active, product_id, required_qty, offer_price, name, description,
-- created_at. Percentage offers need two more columns, added below.

-- ------------------------------------------------------- inventory movements
CREATE TABLE IF NOT EXISTS public.inventory_movements (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL,
  store_id       uuid NOT NULL,
  variant_id     uuid NOT NULL,
  kind           text NOT NULL,
  quantity_delta integer NOT NULL,
  unit_cost      numeric,
  reference      text,
  request_id     uuid,
  created_by     uuid,
  created_at     timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.inventory_movements ADD COLUMN IF NOT EXISTS tenant_id uuid;
ALTER TABLE public.inventory_movements ADD COLUMN IF NOT EXISTS store_id uuid;
ALTER TABLE public.inventory_movements ADD COLUMN IF NOT EXISTS variant_id uuid;
ALTER TABLE public.inventory_movements ADD COLUMN IF NOT EXISTS kind text;
ALTER TABLE public.inventory_movements ADD COLUMN IF NOT EXISTS quantity_delta integer;
ALTER TABLE public.inventory_movements ADD COLUMN IF NOT EXISTS unit_cost numeric;
ALTER TABLE public.inventory_movements ADD COLUMN IF NOT EXISTS reference text;
ALTER TABLE public.inventory_movements ADD COLUMN IF NOT EXISTS request_id uuid;
ALTER TABLE public.inventory_movements ADD COLUMN IF NOT EXISTS created_by uuid;
ALTER TABLE public.inventory_movements ADD COLUMN IF NOT EXISTS created_at timestamptz DEFAULT now();

CREATE UNIQUE INDEX IF NOT EXISTS inventory_movements_request
  ON public.inventory_movements (request_id) WHERE request_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS inventory_movements_variant
  ON public.inventory_movements (variant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS inventory_movements_store
  ON public.inventory_movements (store_id, created_at DESC);

ALTER TABLE public.inventory_movements ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.inventory_movements FROM PUBLIC, anon, authenticated;

-- ------------------------------------------------------------------- offers
ALTER TABLE public.offers ADD COLUMN IF NOT EXISTS discount_percentage integer;
ALTER TABLE public.offers ADD COLUMN IF NOT EXISTS variant_id uuid;
ALTER TABLE public.offers ADD COLUMN IF NOT EXISTS is_active boolean DEFAULT true;

ALTER TABLE public.sale_items ADD COLUMN IF NOT EXISTS offer_id uuid;

ALTER TABLE public.offers ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.offers FROM PUBLIC, anon, authenticated;

-- ------------------------------------------------------- manual stock RPC
CREATE OR REPLACE FUNCTION public.engine_add_stock_manual(
  p_store uuid, p_tenant uuid, p_variant uuid,
  p_quantity integer, p_unit_cost numeric, p_request uuid
) RETURNS numeric
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE staff uuid; old_qty bigint; old_cost numeric; amount numeric;
BEGIN
  staff := public.engine_staff(p_store, p_tenant);
  IF p_quantity IS NULL OR p_quantity <= 0 THEN RAISE EXCEPTION 'الكمية غير صالحة'; END IF;
  IF p_unit_cost IS NULL OR p_unit_cost < 0 THEN RAISE EXCEPTION 'سعر التكلفة مطلوب'; END IF;
  IF p_request IS NULL THEN RAISE EXCEPTION 'طلب غير صالح'; END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(p_request::text, 0));
  IF EXISTS (SELECT 1 FROM public.inventory_movements WHERE request_id = p_request) THEN
    SELECT coalesce(v.cost_price_avg, 0) INTO amount FROM public.product_variants v WHERE v.id = p_variant;
    RETURN amount;
  END IF;

  SELECT v.cost_price_avg INTO old_cost
  FROM public.product_variants v JOIN public.products p ON p.id = v.product_id
  WHERE v.id = p_variant AND p.tenant_id = p_tenant FOR UPDATE OF v;
  IF NOT FOUND THEN RAISE EXCEPTION 'المقاس لا ينتمي إلى المؤسسة'; END IF;

  PERFORM i.id FROM public.inventory i WHERE i.variant_id = p_variant FOR UPDATE;

  -- cost_price_avg is shared by the variant, so weight every store in the
  -- tenant (same rule as engine_receive_purchase).
  SELECT coalesce(sum(i.quantity), 0) INTO old_qty
  FROM public.inventory i JOIN public.stores s ON s.id = i.store_id
  WHERE i.variant_id = p_variant AND s.tenant_id = p_tenant;
  IF old_qty < 0 THEN RAISE EXCEPTION 'لا يمكن حساب التكلفة لمخزون سالب'; END IF;

  amount := ((old_qty * coalesce(old_cost, 0)) + (p_quantity::numeric * p_unit_cost)) / (old_qty + p_quantity);

  UPDATE public.product_variants SET cost_price_avg = amount WHERE id = p_variant;
  INSERT INTO public.inventory(store_id, variant_id, quantity)
    VALUES (p_store, p_variant, p_quantity)
    ON CONFLICT (store_id, variant_id)
    DO UPDATE SET quantity = inventory.quantity + excluded.quantity, updated_at = now();
  INSERT INTO public.inventory_movements(tenant_id, store_id, variant_id, kind, quantity_delta, unit_cost, request_id, created_by)
    VALUES (p_tenant, p_store, p_variant, 'adjustment', p_quantity, p_unit_cost, p_request, staff);
  RETURN amount;
END $$;

-- --------------------------------------------------------- offers RPCs
CREATE OR REPLACE FUNCTION public.engine_offers(p_tenant uuid)
RETURNS TABLE(id uuid, product_id uuid, variant_id uuid, kind text, discount_percentage integer,
              required_qty integer, offer_price integer, name text, description text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE u public.users;
BEGIN
  SELECT * INTO u FROM public.current_staff();
  IF u.id IS NULL OR u.tenant_id IS DISTINCT FROM p_tenant THEN
    RAISE EXCEPTION 'غير مصرح بعرض العروض';
  END IF;
  RETURN QUERY
    SELECT o.id, o.product_id, o.variant_id,
           CASE WHEN o.discount_percentage IS NOT NULL THEN 'percent' ELSE 'bundle' END,
           o.discount_percentage, o.required_qty, o.offer_price, o.name, o.description
    FROM public.offers o
    WHERE o.tenant_id = p_tenant AND coalesce(o.is_active, true)
    ORDER BY o.created_at DESC;
END $$;

CREATE OR REPLACE FUNCTION public.engine_save_offer(
  p_tenant uuid, p_product uuid, p_variant uuid, p_kind text,
  p_discount integer, p_required_qty integer, p_offer_price integer, p_name text
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE u public.users; result uuid;
BEGIN
  SELECT * INTO u FROM public.current_staff();
  IF u.id IS NULL OR u.tenant_id IS DISTINCT FROM p_tenant OR u.role NOT IN ('owner','manager') THEN
    RAISE EXCEPTION 'غير مصرح بإدارة العروض';
  END IF;
  IF p_variant IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.product_variants v JOIN public.products p ON p.id = v.product_id
    WHERE v.id = p_variant AND p.tenant_id = p_tenant
  ) THEN RAISE EXCEPTION 'المقاس غير صالح'; END IF;

  IF p_kind = 'percent' THEN
    IF p_discount IS NULL OR p_discount <= 0 OR p_discount >= 100 THEN RAISE EXCEPTION 'نسبة الخصم غير صالحة'; END IF;
    p_required_qty := NULL; p_offer_price := NULL;
  ELSIF p_kind = 'bundle' THEN
    IF p_required_qty IS NULL OR p_required_qty < 2 OR p_offer_price IS NULL OR p_offer_price <= 0
    THEN RAISE EXCEPTION 'بيانات عرض الحزمة غير صالحة'; END IF;
    p_discount := NULL;
  ELSE
    RAISE EXCEPTION 'نوع العرض غير صالح';
  END IF;

  -- One active offer per variant, so the POS never has to pick between two.
  UPDATE public.offers SET is_active = false
   WHERE tenant_id = p_tenant AND variant_id = p_variant AND coalesce(is_active, true);

  INSERT INTO public.offers(tenant_id, product_id, variant_id, discount_percentage,
                            required_qty, offer_price, name, is_active)
  VALUES (p_tenant, p_product, p_variant, p_discount, p_required_qty, p_offer_price,
          nullif(btrim(p_name), ''), true)
  RETURNING id INTO result;
  RETURN result;
END $$;

CREATE OR REPLACE FUNCTION public.engine_set_offer_active(p_tenant uuid, p_offer uuid, p_active boolean)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE u public.users;
BEGIN
  SELECT * INTO u FROM public.current_staff();
  IF u.id IS NULL OR u.tenant_id IS DISTINCT FROM p_tenant OR u.role NOT IN ('owner','manager') THEN
    RAISE EXCEPTION 'غير مصرح بإدارة العروض';
  END IF;
  UPDATE public.offers SET is_active = coalesce(p_active, false)
   WHERE id = p_offer AND tenant_id = p_tenant;
END $$;

CREATE OR REPLACE FUNCTION public.engine_delete_offer(p_tenant uuid, p_offer uuid)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE u public.users;
BEGIN
  SELECT * INTO u FROM public.current_staff();
  IF u.id IS NULL OR u.tenant_id IS DISTINCT FROM p_tenant OR u.role NOT IN ('owner','manager') THEN
    RAISE EXCEPTION 'غير مصرح بإدارة العروض';
  END IF;
  DELETE FROM public.offers WHERE id = p_offer AND tenant_id = p_tenant;
END $$;

REVOKE ALL ON FUNCTION public.engine_add_stock_manual(uuid,uuid,uuid,integer,numeric,uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.engine_offers(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.engine_save_offer(uuid,uuid,uuid,text,integer,integer,integer,text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.engine_set_offer_active(uuid,uuid,boolean) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.engine_delete_offer(uuid,uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.engine_add_stock_manual(uuid,uuid,uuid,integer,numeric,uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.engine_offers(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.engine_save_offer(uuid,uuid,uuid,text,integer,integer,integer,text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.engine_set_offer_active(uuid,uuid,boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.engine_delete_offer(uuid,uuid) TO authenticated;

-- ------------------------------------- engine_sync_sale: offer-aware totals
-- Copy of the current definition (202611100027_customer_identity, which
-- superseded 202611100025) with four changes:
--   1. total is built from an optional per-line subtotal
--   2. the item recordset also carries subtotal + offer_id
--   3. an active owner-authored offer may sell below min_price
--   4. sale_items records the exact line total and the offer that produced it

CREATE OR REPLACE FUNCTION public.engine_sync_sale(
  p_store uuid, p_tenant uuid, p_local_id text, p_items jsonb, p_payment text,
  p_created_at timestamptz, p_split jsonb DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE
  staff uuid; previous public.sales; result uuid; item record; stock integer;
  floor_price numeric; total numeric; cash_taken bigint; due bigint; method text;
  customer record; found_customer boolean := false;
  customer_key text; customer_phone text; receipt text;
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
 SELECT sum(coalesce(subtotal,quantity*final_price)) INTO total FROM jsonb_to_recordset(p_items) AS x(quantity numeric,final_price numeric,subtotal numeric);
 IF total>2147483647 THEN RAISE EXCEPTION 'إجمالي كبير جداً'; END IF;

 IF p_split IS NULL OR p_split = 'null'::jsonb THEN
   cash_taken := CASE WHEN p_payment='cash' THEN total::bigint ELSE 0 END;
   due := 0; method := NULL;
 ELSE
   BEGIN
     cash_taken := (p_split->>'cash')::bigint;
     due := (p_split->>'amount')::bigint;
     method := nullif(p_split->>'method','');
     customer_key := nullif(trim(p_split->>'customer_name'),'');
     customer_phone := nullif(regexp_replace(trim(coalesce(p_split->>'customer_phone','')), '[\s-]', '', 'g'), '');
     receipt := nullif(trim(p_split->>'receipt_url'),'');
   EXCEPTION WHEN others THEN RAISE EXCEPTION 'بيانات الدفع المختلط غير صالحة'; END;
   IF cash_taken IS NULL OR due IS NULL OR cash_taken < 0 OR due <= 0 THEN RAISE EXCEPTION 'بيانات الدفع المختلط غير صالحة'; END IF;
   IF cash_taken + due <> total::bigint THEN RAISE EXCEPTION 'المدفوع نقداً والمتبقي لا يساويان إجمالي الفاتورة'; END IF;
   IF method IS NULL OR method NOT IN ('credit','check','ccp') THEN RAISE EXCEPTION 'طريقة تسديد المتبقي غير صالحة'; END IF;
   IF method IN ('check','ccp') AND receipt IS NULL THEN RAISE EXCEPTION 'أرفق صورة الشيك أو الوصل'; END IF;
   IF method = 'credit' AND customer_key IS NULL THEN RAISE EXCEPTION 'اسم الزبون مطلوب لتسجيل الكريدي'; END IF;
 END IF;

 INSERT INTO public.sales(store_id,user_id,total_amount,payment_method,status,local_id,synced_at,created_at,sync_items,cash_amount)
 VALUES(p_store,staff,total, CASE WHEN method IS NULL THEN p_payment ELSE 'cash' END,'completed',p_local_id,now(),p_created_at,p_items,cash_taken)
 RETURNING id INTO result;

 FOR item IN SELECT * FROM jsonb_to_recordset(p_items) AS x(variant_id uuid,quantity integer,final_price integer,original_price integer,subtotal numeric,offer_id uuid) ORDER BY variant_id LOOP
  SELECT coalesce(v.min_price,0) INTO floor_price FROM public.product_variants v JOIN public.products p ON p.id=v.product_id WHERE v.id=item.variant_id AND p.tenant_id=p_tenant AND p.is_active=true FOR UPDATE OF v;
  IF NOT FOUND THEN RAISE EXCEPTION 'مقاس غير متاح. راجع الفاتورة المحلية'; END IF;
  -- Only an active offer of this tenant, for this very variant, unlocks the floor.
  IF item.final_price<floor_price AND NOT EXISTS(SELECT 1 FROM public.offers o WHERE o.id=item.offer_id AND o.tenant_id=p_tenant AND o.variant_id=item.variant_id AND coalesce(o.is_active,true)) THEN RAISE EXCEPTION 'سعر أقل من الحد الأدنى بدون عرض ساري. راجع الفاتورة المحلية'; END IF;
  -- A line total may discount, never inflate, and must stay a whole positive amount.
  IF item.subtotal IS NOT NULL AND (item.subtotal<=0 OR item.subtotal<>trunc(item.subtotal) OR item.subtotal>item.quantity*greatest(item.original_price,item.final_price)) THEN RAISE EXCEPTION 'إجمالي بند غير صالح. راجع الفاتورة المحلية'; END IF;
  SELECT quantity INTO stock FROM public.inventory WHERE variant_id=item.variant_id AND store_id=p_store FOR UPDATE;
  IF NOT FOUND OR stock<item.quantity THEN RAISE EXCEPTION 'المخزون غير كافٍ. راجع الفاتورة المحلية'; END IF;
  UPDATE public.inventory SET quantity=quantity-item.quantity,updated_at=now() WHERE variant_id=item.variant_id AND store_id=p_store;
  INSERT INTO public.sale_items(sale_id,variant_id,quantity,original_price,final_price,unit_price,subtotal,offer_id) VALUES(result,item.variant_id,item.quantity,item.original_price,item.final_price,item.final_price,coalesce(item.subtotal,item.final_price::numeric*item.quantity),item.offer_id);
 END LOOP;

 IF method = 'credit' THEN
   -- An id chosen from the autocomplete wins: the cashier already confirmed
   -- which row this is, so there is nothing to match.
   IF nullif(trim(p_split->>'customer_id'),'') IS NOT NULL THEN
     SELECT * INTO customer FROM public.customers
      WHERE id = (p_split->>'customer_id')::uuid AND tenant_id = p_tenant;
     found_customer := FOUND;
   END IF;
   -- Phone first (normalised on both sides), then the case-insensitive name.
   -- `FOUND` is tested after every SELECT INTO and the boolean is used for the
   -- rest: reading a field of a record that was never assigned raises
   -- 55000 "record customer is not assigned yet".
   IF customer_phone IS NOT NULL THEN
     SELECT * INTO customer FROM public.customers
      WHERE tenant_id = p_tenant
        AND regexp_replace(coalesce(phone,''), '[\s-]', '', 'g') = customer_phone
      ORDER BY id LIMIT 1;
     found_customer := FOUND;
   END IF;
   IF NOT found_customer THEN
     SELECT * INTO customer FROM public.customers
      WHERE tenant_id = p_tenant AND match_key = public.customer_match_key(customer_key)
      ORDER BY id LIMIT 1;
     found_customer := FOUND;
   END IF;
   IF NOT found_customer THEN
     -- `ON CONFLICT DO NOTHING` covers the race where two tills create the same
     -- new customer at once: the loser's insert is dropped and the row is then
     -- read back, so both sales land on one customer instead of two.
     INSERT INTO public.customers(tenant_id, name, phone)
     VALUES(p_tenant, customer_key, customer_phone)
     ON CONFLICT (tenant_id, match_key) WHERE match_key IS NOT NULL DO NOTHING
     RETURNING * INTO customer;
     found_customer := FOUND;
     IF NOT found_customer THEN
       SELECT * INTO customer FROM public.customers
        WHERE tenant_id = p_tenant AND match_key = public.customer_match_key(customer_key)
        ORDER BY id LIMIT 1;
       found_customer := FOUND;
     END IF;
   END IF;
   -- A credit sale must never be stored without a customer.
   IF NOT found_customer OR customer.id IS NULL THEN
     RAISE EXCEPTION 'تعذر تحديد الزبون لتسجيل الكريدي';
   END IF;
   INSERT INTO public.credits(store_id, created_by, customer_id, total_amount, remaining_amount, description, status, sale_id)
   VALUES(p_store, staff, customer.id, due, due, 'فاتورة بيع مختلط', 'active', result);
 ELSIF method IN ('check','ccp') THEN
   INSERT INTO public.pending_collections(store_id, customer_name, amount, payment_method, receipt_url, status, sale_id)
   VALUES(p_store, coalesce(customer_key,''), due, method, receipt, 'pending', result);
 END IF;

 RETURN result;
END $$;

CREATE OR REPLACE FUNCTION public.engine_sync_sale_for_staff(
  p_store uuid, p_tenant uuid, p_local_id text, p_items jsonb, p_payment text,
  p_created_at timestamptz, p_staff uuid, p_split jsonb DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
BEGIN
 IF public.current_staff_id() IS DISTINCT FROM p_staff THEN RAISE EXCEPTION 'تغير المستخدم أثناء المزامنة'; END IF;
 RETURN public.engine_sync_sale(p_store,p_tenant,p_local_id,p_items,p_payment,p_created_at,p_split);
END $$;

REVOKE ALL ON FUNCTION public.engine_sync_sale(uuid,uuid,text,jsonb,text,timestamptz,jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.engine_sync_sale(uuid,uuid,text,jsonb,text,timestamptz,jsonb) TO authenticated;
REVOKE ALL ON FUNCTION public.engine_sync_sale_for_staff(uuid,uuid,text,jsonb,text,timestamptz,uuid,jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.engine_sync_sale_for_staff(uuid,uuid,text,jsonb,text,timestamptz,uuid,jsonb) TO authenticated;
