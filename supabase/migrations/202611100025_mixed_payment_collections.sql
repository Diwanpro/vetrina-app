-- 025: mixed payment at the till + pending collections (cheques / CCP receipts)
--
-- Three problems this migration solves, all of them money-safety issues:
--
-- 1. `sales.total_amount` is the full invoice, so the drawer used to absorb the
--    whole ticket even when part of it was a cheque. `sales.cash_amount` records
--    the cash actually taken, and close-shift sums that instead.
-- 2. A sale that is partly settled by cheque or credit is created only once the
--    browser's outbox syncs, because the real sale id does not exist before then.
--    The split therefore travels with the sync call and is written in the same
--    transaction: a sale can never be stored without its debt.
-- 3. Clearing a cheque into the drawer must not be booked as revenue a second
--    time — the invoice already counted it on the day of the sale. Cleared cash
--    only moves into `shifts.total_collections`; cleared bank touches nothing.
--
-- Apply after 024. Everything here is idempotent.

-- ---------------------------------------------------------------- schema
ALTER TABLE public.sales ADD COLUMN IF NOT EXISTS cash_amount bigint;

-- Older sales predate the split: a cash sale was paid in full, anything else
-- never touched the drawer. Backfill before the column is read by close-shift.
UPDATE public.sales SET cash_amount = CASE WHEN payment_method = 'cash' THEN total_amount ELSE 0 END
 WHERE cash_amount IS NULL;

ALTER TABLE public.sales ALTER COLUMN cash_amount SET DEFAULT 0;
UPDATE public.sales SET cash_amount = 0 WHERE cash_amount IS NULL;
ALTER TABLE public.sales ALTER COLUMN cash_amount SET NOT NULL;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'sales_cash_amount_valid') THEN
    ALTER TABLE public.sales ADD CONSTRAINT sales_cash_amount_valid
      CHECK (cash_amount >= 0 AND cash_amount <= total_amount);
  END IF;
END $$;

-- A debt born at the till points at the invoice that created it.
ALTER TABLE public.credits ADD COLUMN IF NOT EXISTS sale_id uuid;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'credits_sale_id_fkey') THEN
    ALTER TABLE public.credits ADD CONSTRAINT credits_sale_id_fkey
      FOREIGN KEY (sale_id) REFERENCES public.sales(id) ON DELETE SET NULL;
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS credits_sale_id ON public.credits(sale_id) WHERE sale_id IS NOT NULL;

-- The table was created by hand, so normalise the parts the code depends on.
ALTER TABLE public.pending_collections ADD COLUMN IF NOT EXISTS sale_id uuid;
ALTER TABLE public.pending_collections ADD COLUMN IF NOT EXISTS cleared_shift_id uuid;

DO $$ BEGIN
  IF (SELECT data_type FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'pending_collections' AND column_name = 'id') = 'uuid'
     AND (SELECT column_default FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'pending_collections' AND column_name = 'id') IS NULL THEN
    ALTER TABLE public.pending_collections ALTER COLUMN id SET DEFAULT gen_random_uuid();
  END IF;
  IF (SELECT column_default FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'pending_collections' AND column_name = 'status') IS NULL THEN
    ALTER TABLE public.pending_collections ALTER COLUMN status SET DEFAULT 'pending';
  END IF;
  IF (SELECT column_default FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'pending_collections' AND column_name = 'created_at') IS NULL THEN
    ALTER TABLE public.pending_collections ALTER COLUMN created_at SET DEFAULT now();
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'pending_collections_status_check') THEN
    ALTER TABLE public.pending_collections ADD CONSTRAINT pending_collections_status_check
      CHECK (status IN ('pending', 'cleared_cash', 'cleared_bank'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'pending_collections_method_check') THEN
    ALTER TABLE public.pending_collections ADD CONSTRAINT pending_collections_method_check
      CHECK (payment_method IN ('check', 'ccp'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'pending_collections_amount_check') THEN
    ALTER TABLE public.pending_collections ADD CONSTRAINT pending_collections_amount_check
      CHECK (amount > 0);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS pending_collections_store_status
  ON public.pending_collections(store_id, status, created_at DESC);
-- One cheque per sale: a replayed sync must not queue the same paper twice.
CREATE UNIQUE INDEX IF NOT EXISTS pending_collections_sale
  ON public.pending_collections(sale_id) WHERE sale_id IS NOT NULL;

-- Cleared cheque money lands here, separately from settled customer credit so
-- the shift report can tell the two apart.
ALTER TABLE public.shifts ADD COLUMN IF NOT EXISTS total_collections bigint NOT NULL DEFAULT 0;

-- ------------------------------------------------- split-aware sale sync
-- A DEFAULT argument creates an overload rather than replacing the old body, and
-- PostgREST resolves the exact arity, so the previous signatures are dropped.
DROP FUNCTION IF EXISTS public.engine_sync_sale(uuid, uuid, text, jsonb, text, timestamptz);
DROP FUNCTION IF EXISTS public.engine_sync_sale_for_staff(uuid, uuid, text, jsonb, text, timestamptz, uuid);

CREATE FUNCTION public.engine_sync_sale(
  p_store uuid, p_tenant uuid, p_local_id text, p_items jsonb, p_payment text,
  p_created_at timestamptz, p_split jsonb DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE
  staff uuid; previous public.sales; result uuid; item record; stock integer;
  floor_price numeric; total numeric; cash_taken bigint; due bigint; method text;
  customer record; customer_key text; receipt text;
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

 -- No split: the old behaviour, the whole ticket in the stated method.
 IF p_split IS NULL OR p_split = 'null'::jsonb THEN
   cash_taken := CASE WHEN p_payment='cash' THEN total::bigint ELSE 0 END;
   due := 0; method := NULL;
 ELSE
   BEGIN
     cash_taken := (p_split->>'cash')::bigint;
     due := (p_split->>'amount')::bigint;
     method := nullif(p_split->>'method','');
     customer_key := nullif(trim(p_split->>'customer_name'),'');
     receipt := nullif(trim(p_split->>'receipt_url'),'');
   EXCEPTION WHEN others THEN RAISE EXCEPTION 'بيانات الدفع المختلط غير صالحة'; END;
   IF cash_taken IS NULL OR due IS NULL OR cash_taken < 0 OR due <= 0 THEN RAISE EXCEPTION 'بيانات الدفع المختلط غير صالحة'; END IF;
   IF cash_taken + due <> total::bigint THEN RAISE EXCEPTION 'المدفوع نقداً والمتبقي لا يساويان إجمالي الفاتورة'; END IF;
   -- `x NOT IN (...)` is NULL when x is NULL, so a missing method would slip
   -- through and the remainder would disappear with no debt and no receipt.
   IF method IS NULL OR method NOT IN ('credit','check','ccp') THEN RAISE EXCEPTION 'طريقة تسديد المتبقي غير صالحة'; END IF;
   IF method IN ('check','ccp') AND receipt IS NULL THEN RAISE EXCEPTION 'أرفق صورة الشيك أو الوصل'; END IF;
   IF method = 'credit' AND customer_key IS NULL THEN RAISE EXCEPTION 'اسم الزبون مطلوب لتسجيل الكريدي'; END IF;
 END IF;

 INSERT INTO public.sales(store_id,user_id,total_amount,payment_method,status,local_id,synced_at,created_at,sync_items,cash_amount)
 VALUES(p_store,staff,total, CASE WHEN method IS NULL THEN p_payment ELSE 'cash' END,'completed',p_local_id,now(),p_created_at,p_items,cash_taken)
 RETURNING id INTO result;

 FOR item IN SELECT * FROM jsonb_to_recordset(p_items) AS x(variant_id uuid,quantity integer,final_price integer,original_price integer) ORDER BY variant_id LOOP
  SELECT coalesce(v.min_price,0) INTO floor_price FROM public.product_variants v JOIN public.products p ON p.id=v.product_id WHERE v.id=item.variant_id AND p.tenant_id=p_tenant AND p.is_active=true FOR UPDATE OF v;
  IF NOT FOUND OR item.final_price<floor_price THEN RAISE EXCEPTION 'مقاس غير متاح أو سعر أقل من الحد الأدنى. راجع الفاتورة المحلية'; END IF;
  SELECT quantity INTO stock FROM public.inventory WHERE variant_id=item.variant_id AND store_id=p_store FOR UPDATE;
  IF NOT FOUND OR stock<item.quantity THEN RAISE EXCEPTION 'المخزون غير كافٍ. راجع الفاتورة المحلية'; END IF;
  UPDATE public.inventory SET quantity=quantity-item.quantity,updated_at=now() WHERE variant_id=item.variant_id AND store_id=p_store;
  INSERT INTO public.sale_items(sale_id,variant_id,quantity,original_price,final_price,unit_price,subtotal) VALUES(result,item.variant_id,item.quantity,item.original_price,item.final_price,item.final_price,item.final_price::numeric*item.quantity);
 END LOOP;

 -- The remainder. Written inside the sale transaction: if this fails the whole
 -- sale rolls back and the outbox keeps it for retry, never a sale with no debt.
 IF method = 'credit' THEN
   -- Match on the tenant only. Scoping the lookup through this store's credits
   -- meant a customer whose debts lived in another branch was never found and
   -- was re-created on every credit. Phone is the stronger key when supplied.
   IF nullif(trim(p_split->>'customer_phone'),'') IS NOT NULL THEN
     SELECT * INTO customer FROM public.customers
      WHERE tenant_id = p_tenant AND phone = trim(p_split->>'customer_phone')
      ORDER BY id LIMIT 1;
   END IF;
   IF customer.id IS NULL THEN
     SELECT * INTO customer FROM public.customers
      WHERE tenant_id = p_tenant AND name = customer_key
      ORDER BY id LIMIT 1;
   END IF;
   IF customer.id IS NULL THEN
     INSERT INTO public.customers(tenant_id, name, phone)
     VALUES(p_tenant, customer_key, nullif(trim(p_split->>'customer_phone'),''))
     RETURNING * INTO customer;
   END IF;
   INSERT INTO public.credits(store_id, created_by, customer_id, total_amount, remaining_amount, description, status, sale_id)
   VALUES(p_store, staff, customer.id, due, due, 'فاتورة بيع مختلط', 'active', result);
 ELSIF method IN ('check','ccp') THEN
   INSERT INTO public.pending_collections(store_id, customer_name, amount, payment_method, receipt_url, status, sale_id)
   VALUES(p_store, coalesce(customer_key,''), due, method, receipt, 'pending', result);
 END IF;

 RETURN result;
END $$;

CREATE FUNCTION public.engine_sync_sale_for_staff(
  p_store uuid, p_tenant uuid, p_local_id text, p_items jsonb, p_payment text,
  p_created_at timestamptz, p_staff uuid, p_split jsonb DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
BEGIN
 IF public.current_staff_id() IS DISTINCT FROM p_staff THEN RAISE EXCEPTION 'تغير المستخدم أثناء المزامنة'; END IF;
 RETURN public.engine_sync_sale(p_store,p_tenant,p_local_id,p_items,p_payment,p_created_at,p_split);
END $$;

-- ------------------------------------------------------------- close shift
-- Same signature, so a plain replace is enough. Cash sales now contribute the
-- cash actually handed over, and cleared cheques are counted separately.
CREATE OR REPLACE FUNCTION public.engine_close_shift(
  p_shift uuid, p_actual integer, p_expected bigint, p_difference bigint, p_notes text
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE u public.users; s public.shifts; sales bigint; expected bigint;
BEGIN
  SELECT * INTO u FROM public.current_staff();
  SELECT * INTO s FROM public.shifts WHERE id = p_shift FOR UPDATE;
  PERFORM public.engine_validate(s.store_id, u.tenant_id, ARRAY['owner','manager','employee']);
  IF s.id IS NULL OR s.status <> 'open' THEN RAISE EXCEPTION 'الوردية مغلقة'; END IF;
  SELECT coalesce(sum(x.cash_amount), 0) INTO sales
    FROM public.sales x JOIN public.stores st ON st.id = x.store_id
   WHERE x.store_id = s.store_id AND st.tenant_id = u.tenant_id
     AND x.status = 'completed'
     AND x.created_at >= s.start_time AND x.created_at < now();
  expected := s.expected_cash::bigint + sales - s.total_employee_payments
              + coalesce(s.total_credit_payments, 0) + coalesce(s.total_collections, 0);
  IF p_actual IS NULL OR p_actual < 0 OR p_expected IS DISTINCT FROM expected
     OR p_difference IS DISTINCT FROM p_actual::bigint - expected THEN
    RAISE EXCEPTION 'تغير الصندوق. أعد فتح التقفيلة وراجع النقد المتوقع';
  END IF;
  IF p_difference <> 0 AND nullif(trim(p_notes), '') IS NULL THEN
    RAISE EXCEPTION 'يجب توضيح سبب الفرق';
  END IF;
  UPDATE public.shifts
  SET expected_cash = expected, actual_cash = p_actual, difference = p_difference,
      total_cash_sales = sales, notes = p_notes, status = 'closed',
      end_time = now(), closed_at = now()
  WHERE id = s.id;
END $$;

-- ------------------------------------------------------- pending collections
CREATE OR REPLACE FUNCTION public.engine_pending_collections(p_store uuid DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public AS $$
DECLARE u public.users; rows jsonb;
BEGIN
  SELECT * INTO u FROM public.current_staff();
  IF u.id IS NULL THEN RAISE EXCEPTION 'غير مصرح'; END IF;
  IF p_store IS NOT NULL THEN PERFORM public.engine_validate(p_store, u.tenant_id, ARRAY['owner','manager','employee']); END IF;
  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'id', pc.id, 'storeId', pc.store_id, 'customerName', pc.customer_name,
           'amount', pc.amount, 'method', pc.payment_method, 'receipt', pc.receipt_url,
           'status', pc.status, 'createdAt', pc.created_at, 'clearedAt', pc.cleared_at,
           'saleId', pc.sale_id) ORDER BY pc.created_at DESC), '[]'::jsonb)
    INTO rows
    FROM public.pending_collections pc
    JOIN public.stores st ON st.id = pc.store_id
   WHERE st.tenant_id = u.tenant_id
     AND (p_store IS NULL OR pc.store_id = p_store)
     AND pc.status = 'pending';
  RETURN rows;
END $$;

-- Clearing a cheque. `cash` moves the money into the open drawer; `bank` only
-- books the movement. Neither adds revenue: the invoice already counted it.
CREATE OR REPLACE FUNCTION public.engine_clear_pending_collection(
  p_id uuid, p_destination text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE u public.users; pc public.pending_collections; s public.shifts; new_status text;
BEGIN
  SELECT * INTO u FROM public.current_staff();
  IF u.id IS NULL THEN RAISE EXCEPTION 'غير مصرح'; END IF;
  -- NULL would make NOT IN evaluate to NULL and skip the guard entirely.
  IF p_destination IS NULL OR p_destination NOT IN ('cash','bank') THEN RAISE EXCEPTION 'اختر الصندوق أو البنك'; END IF;

  -- Lock the row so a double click cannot credit the drawer twice.
  SELECT * INTO pc FROM public.pending_collections WHERE id = p_id FOR UPDATE;
  IF pc.id IS NULL THEN RAISE EXCEPTION 'التحصيل غير موجود'; END IF;
  PERFORM public.engine_validate(pc.store_id, u.tenant_id, ARRAY['owner','manager','employee']);
  IF pc.status <> 'pending' THEN RAISE EXCEPTION 'تم تحصيل هذا الشيك مسبقاً'; END IF;

  IF p_destination = 'cash' THEN
    SELECT * INTO s FROM public.shifts
     WHERE store_id = pc.store_id AND status = 'open' ORDER BY start_time DESC LIMIT 1 FOR UPDATE;
    IF s.id IS NULL THEN RAISE EXCEPTION 'افتح صندوق الفرع قبل التحصيل'; END IF;
    UPDATE public.shifts SET total_collections = coalesce(total_collections,0) + pc.amount WHERE id = s.id;
    new_status := 'cleared_cash';
  ELSE
    new_status := 'cleared_bank';
  END IF;

  UPDATE public.pending_collections
     SET status = new_status, cleared_at = now(), cleared_shift_id = s.id
   WHERE id = pc.id;

  RETURN jsonb_build_object('ok', true, 'status', new_status, 'amount', pc.amount,
                            'shiftId', s.id, 'destination', p_destination);
END $$;

-- ------------------------------------------------------------ permissions
REVOKE ALL ON FUNCTION public.engine_sync_sale(uuid, uuid, text, jsonb, text, timestamptz, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.engine_sync_sale(uuid, uuid, text, jsonb, text, timestamptz, jsonb) TO authenticated;
REVOKE ALL ON FUNCTION public.engine_sync_sale_for_staff(uuid, uuid, text, jsonb, text, timestamptz, uuid, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.engine_sync_sale_for_staff(uuid, uuid, text, jsonb, text, timestamptz, uuid, jsonb) TO authenticated;
REVOKE ALL ON FUNCTION public.engine_pending_collections(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.engine_pending_collections(uuid) TO authenticated;
REVOKE ALL ON FUNCTION public.engine_clear_pending_collection(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.engine_clear_pending_collection(uuid, text) TO authenticated;
