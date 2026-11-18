-- The staff receipt belongs to an auth user; the expense author is a public.users id.
-- No DEFAULT on the seventh argument: PostgREST can resolve the old and new key sets exactly.
CREATE OR REPLACE FUNCTION public.engine_record_expense_for_staff(
  p_store uuid, p_amount integer, p_description text, p_receipt text, p_request uuid, p_staff uuid, p_category text
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  u public.users;
  old public.expenses;
  clean_category text := nullif(trim(p_category), '');
  result uuid;
BEGIN
  SELECT * INTO u FROM public.current_staff();
  IF u.id IS NULL OR u.role IS NULL OR u.id IS DISTINCT FROM p_staff THEN
    RAISE EXCEPTION 'تغير حساب المستخدم. أعد تسجيل المصروف من الحساب الصحيح';
  END IF;
  PERFORM public.engine_validate(p_store, u.tenant_id, ARRAY['owner','manager','employee']);
  IF p_amount IS NULL OR p_amount <= 0 OR nullif(trim(p_description), '') IS NULL
     OR length(p_description) > 1000 OR p_request IS NULL THEN
    RAISE EXCEPTION 'أدخل مبلغاً موجباً ووصفاً صحيحاً';
  END IF;
  IF length(clean_category) > 80 THEN RAISE EXCEPTION 'التصنيف طويل جداً'; END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(p_request::text, 0));
  SELECT * INTO old FROM public.expenses WHERE request_id = p_request;
  IF FOUND THEN
    IF old.store_id IS DISTINCT FROM p_store OR old.created_by IS DISTINCT FROM u.id
       OR old.amount IS DISTINCT FROM p_amount OR old.description IS DISTINCT FROM trim(p_description)
       OR old.receipt_url IS DISTINCT FROM p_receipt OR old.category IS DISTINCT FROM clean_category THEN
      RAISE EXCEPTION 'طلب مكرر ببيانات مختلفة';
    END IF;
    RETURN old.id;
  END IF;

  IF p_receipt IS NOT NULL AND (
    public.engine_receipt_access(p_receipt, true) IS NOT TRUE
    OR split_part(p_receipt, '/', 2) <> p_store::text
    OR NOT EXISTS (SELECT 1 FROM storage.objects WHERE bucket_id = 'expense-receipts' AND name = p_receipt)
  ) THEN RAISE EXCEPTION 'المرفق غير صالح'; END IF;

  INSERT INTO public.expenses(store_id, amount, description, category, receipt_url, created_by, status, request_id)
  VALUES (p_store, p_amount, trim(p_description), clean_category, p_receipt, u.id, 'approved', p_request)
  RETURNING id INTO result;
  RETURN result;
END $$;

-- Keep the original signature (including parameter names) for the top bar.
CREATE OR REPLACE FUNCTION public.engine_record_expense_for_staff(
  p_store uuid, p_amount integer, p_description text, p_receipt text, p_request uuid, p_staff uuid
) RETURNS uuid LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT public.engine_record_expense_for_staff(p_store, p_amount, p_description, p_receipt, p_request, p_staff, NULL::text);
$$;

-- Preserve the v2 signature, branch-scoped receipts and replay contract for management.
CREATE OR REPLACE FUNCTION public.engine_record_expense_v2(
  p_store uuid, p_amount integer, p_description text, p_category text, p_receipt text, p_request uuid
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE u public.users; old public.expenses; result uuid; clean_category text;
BEGIN
  SELECT * INTO u FROM public.current_staff();
  IF u.role IS NULL OR u.role NOT IN ('owner','manager') THEN
    RAISE EXCEPTION 'هذا المسار متاح للمالك والمدير فقط' USING ERRCODE = '42501';
  END IF;
  PERFORM public.engine_validate(p_store, u.tenant_id, ARRAY['owner','manager']);
  IF p_amount IS NULL OR p_amount <= 0 OR nullif(trim(p_description), '') IS NULL OR length(p_description) > 1000 OR p_request IS NULL THEN
    RAISE EXCEPTION 'أدخل مبلغاً موجباً ووصفاً صحيحاً';
  END IF;
  clean_category := nullif(trim(coalesce(p_category, '')), '');
  IF clean_category IS NOT NULL AND length(clean_category) > 80 THEN RAISE EXCEPTION 'التصنيف طويل جداً'; END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(p_request::text, 0));
  SELECT * INTO old FROM public.expenses WHERE request_id = p_request;
  IF old.id IS NOT NULL THEN
    IF old.store_id <> p_store OR old.created_by <> u.id OR old.amount <> p_amount
       OR old.description IS DISTINCT FROM trim(p_description) OR old.receipt_url IS DISTINCT FROM p_receipt THEN
      RAISE EXCEPTION 'طلب مكرر ببيانات مختلفة';
    END IF;
    RETURN old.id;
  END IF;

  IF p_receipt IS NOT NULL AND (
    split_part(p_receipt, '/', 1) <> u.tenant_id::text
    OR split_part(p_receipt, '/', 2) <> p_store::text
    OR NOT EXISTS (SELECT 1 FROM storage.objects WHERE bucket_id = 'receipts' AND name = p_receipt)
  ) THEN RAISE EXCEPTION 'المرفق غير صالح'; END IF;

  INSERT INTO public.expenses(store_id, amount, description, category, receipt_url, created_by, status, request_id)
  VALUES (p_store, p_amount, trim(p_description), clean_category, p_receipt, u.id, 'approved', p_request)
  RETURNING id INTO result;
  RETURN result;
END $$;

REVOKE ALL ON FUNCTION public.engine_record_expense_for_staff(uuid,integer,text,text,uuid,uuid,text),
  public.engine_record_expense_for_staff(uuid,integer,text,text,uuid,uuid),
  public.engine_record_expense_v2(uuid,integer,text,text,text,uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.engine_record_expense_for_staff(uuid,integer,text,text,uuid,uuid,text),
  public.engine_record_expense_for_staff(uuid,integer,text,text,uuid,uuid),
  public.engine_record_expense_v2(uuid,integer,text,text,text,uuid) TO authenticated;

NOTIFY pgrst, 'reload schema';
