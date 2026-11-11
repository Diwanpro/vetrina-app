-- 027: one customer identity, matched the same way everywhere
--
-- The till kept creating duplicate customers. Two separate causes:
--
-- 1. `engine_sync_sale` matched with `name = customer_key`, which is exact and
--    case-sensitive. The table is filled by hand, so `Ali`, `ali ` and `ALI `
--    never matched and each one became a new row.
-- 2. Even with a match, nothing stopped a second concurrent sale for the same
--    person from inserting twice: there is no unique key, and the lookup runs
--    before the insert with nothing held between them.
--
-- This migration adds a normalised-key column so the comparison is done by the
-- database, backs it up with a unique index to make duplication impossible
-- rather than merely unlikely, and makes every write path populate it.
--
-- Apply after 026. Idempotent.

-- ------------------------------------------------- normalised identity
-- Lowercase, collapse runs of whitespace, trim. Postgres' builtin `lower` is
-- locale-aware; for the Arabic and Latin names in use here it folds case as
-- expected without changing the letters themselves.
CREATE OR REPLACE FUNCTION public.customer_match_key(p_name text)
RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT nullif(lower(regexp_replace(btrim(coalesce(p_name, '')), '\s+', ' ', 'g')), '')
$$;

ALTER TABLE public.customers ADD COLUMN IF NOT EXISTS match_key text;

-- Backfill, resolving any pre-existing duplicates by keeping the oldest row and
-- leaving the rest with a suffixed key so the unique index can be created.
-- Their debts are untouched: this migration never moves or merges money.
DO $$
DECLARE suffixed integer;
BEGIN
  UPDATE public.customers
     SET match_key = public.customer_match_key(name)
   WHERE match_key IS DISTINCT FROM public.customer_match_key(name);

  -- Set-based, in one statement: a row-by-row loop that both reads and writes
  -- the same table lets later iterations see rows it has already rewritten.
  -- The one-time expression depends only on the old key and the row id, so it
  -- can never collide with another suffixed row.
  WITH ranked AS (
    SELECT id, tenant_id, match_key,
           row_number() OVER (PARTITION BY tenant_id, match_key ORDER BY id) AS rn
      FROM public.customers
     WHERE match_key IS NOT NULL
  )
  UPDATE public.customers target
     SET match_key = ranked.match_key || '#' || ranked.id::text
    FROM ranked
   WHERE target.id = ranked.id AND ranked.rn > 1;

  GET DIAGNOSTICS suffixed = ROW_COUNT;
  IF suffixed > 0 THEN
    RAISE NOTICE 'kept % pre-existing duplicate customer rows (debts left untouched)', suffixed;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS customers_tenant_match_key
  ON public.customers(tenant_id, match_key) WHERE match_key IS NOT NULL;

-- Any insert that forgets the key would otherwise silently bypass the index.
CREATE OR REPLACE FUNCTION public.customers_fill_match_key()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.match_key := public.customer_match_key(NEW.name);
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS customers_match_key ON public.customers;
CREATE TRIGGER customers_match_key
  BEFORE INSERT OR UPDATE OF name ON public.customers
  FOR EACH ROW EXECUTE FUNCTION public.customers_fill_match_key();

-- ------------------------------------------- case-insensitive credit match
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
 SELECT sum(quantity*final_price) INTO total FROM jsonb_to_recordset(p_items) AS x(quantity numeric,final_price numeric);
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

 FOR item IN SELECT * FROM jsonb_to_recordset(p_items) AS x(variant_id uuid,quantity integer,final_price integer,original_price integer) ORDER BY variant_id LOOP
  SELECT coalesce(v.min_price,0) INTO floor_price FROM public.product_variants v JOIN public.products p ON p.id=v.product_id WHERE v.id=item.variant_id AND p.tenant_id=p_tenant AND p.is_active=true FOR UPDATE OF v;
  IF NOT FOUND OR item.final_price<floor_price THEN RAISE EXCEPTION 'مقاس غير متاح أو سعر أقل من الحد الأدنى. راجع الفاتورة المحلية'; END IF;
  SELECT quantity INTO stock FROM public.inventory WHERE variant_id=item.variant_id AND store_id=p_store FOR UPDATE;
  IF NOT FOUND OR stock<item.quantity THEN RAISE EXCEPTION 'المخزون غير كافٍ. راجع الفاتورة المحلية'; END IF;
  UPDATE public.inventory SET quantity=quantity-item.quantity,updated_at=now() WHERE variant_id=item.variant_id AND store_id=p_store;
  INSERT INTO public.sale_items(sale_id,variant_id,quantity,original_price,final_price,unit_price,subtotal) VALUES(result,item.variant_id,item.quantity,item.original_price,item.final_price,item.final_price,item.final_price::numeric*item.quantity);
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

-- The manual "add credit" path from the credits screen writes rows directly, so
-- it gets the same treatment through a function the client calls instead.
CREATE OR REPLACE FUNCTION public.engine_create_credit(
  p_store uuid, p_name text, p_phone text, p_amount integer, p_description text, p_due_date date
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE u public.users; customer record; found_customer boolean := false;
        clean_phone text; clean_name text; created_customer boolean := false; credit_id uuid;
BEGIN
  SELECT * INTO u FROM public.current_staff();
  PERFORM public.engine_validate(p_store, u.tenant_id, ARRAY['owner','manager','employee']);
  clean_name := nullif(regexp_replace(btrim(coalesce(p_name,'')), '\s+', ' ', 'g'), '');
  clean_phone := nullif(regexp_replace(btrim(coalesce(p_phone,'')), '[\s-]', '', 'g'), '');
  IF clean_name IS NULL THEN RAISE EXCEPTION 'اسم الزبون مطلوب'; END IF;
  IF p_amount IS NULL OR p_amount <= 0 OR p_amount > 2147483647 THEN RAISE EXCEPTION 'المبلغ غير صالح'; END IF;

  IF clean_phone IS NOT NULL THEN
    SELECT * INTO customer FROM public.customers
     WHERE tenant_id = u.tenant_id AND regexp_replace(coalesce(phone,''), '[\s-]', '', 'g') = clean_phone
     ORDER BY id LIMIT 1;
    found_customer := FOUND;
  END IF;
  IF NOT found_customer THEN
    SELECT * INTO customer FROM public.customers
     WHERE tenant_id = u.tenant_id AND match_key = public.customer_match_key(clean_name)
     ORDER BY id LIMIT 1;
    found_customer := FOUND;
  END IF;
  IF NOT found_customer THEN
    INSERT INTO public.customers(tenant_id, name, phone)
    VALUES(u.tenant_id, clean_name, clean_phone)
    ON CONFLICT (tenant_id, match_key) WHERE match_key IS NOT NULL DO NOTHING
    RETURNING * INTO customer;
    found_customer := FOUND;
    created_customer := FOUND;
    IF NOT found_customer THEN
      SELECT * INTO customer FROM public.customers
       WHERE tenant_id = u.tenant_id AND match_key = public.customer_match_key(clean_name)
       ORDER BY id LIMIT 1;
      found_customer := FOUND;
    END IF;
  END IF;
  IF NOT found_customer OR customer.id IS NULL THEN
    RAISE EXCEPTION 'تعذر تحديد الزبون لتسجيل الكريدي';
  END IF;

  INSERT INTO public.credits(store_id, created_by, customer_id, total_amount, remaining_amount, description, due_date, status)
  VALUES(p_store, u.id, customer.id, p_amount, p_amount, nullif(btrim(coalesce(p_description,'')), ''), p_due_date, 'active')
  RETURNING id INTO credit_id;

  RETURN jsonb_build_object('creditId', credit_id, 'customerId', customer.id,
                            'customerName', customer.name, 'createdCustomer', created_customer);
END $$;

REVOKE ALL ON FUNCTION public.engine_create_credit(uuid, text, text, integer, text, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.engine_create_credit(uuid, text, text, integer, text, date) TO authenticated;
