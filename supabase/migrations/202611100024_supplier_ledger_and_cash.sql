-- Supplier ledger: totals, invoices and payments in one call, plus the
-- tenant-scoped close-shift arithmetic and credit-payment-aware expected cash.
--
-- Two independent bugs motivated the function changes below.
--
-- 1. engine_credit_payment counted every credit payment received during a shift
--    as cash in the drawer. The POS records a credit portion as a single 'ccp'
--    sale, so the same money was counted twice: once as the sale and once as the
--    "credit" payment. A customer settling a credit with anything other than
--    cash produced a phantom surplus, and closing a shift could insist on cash
--    that did not exist. Credit payments are only cash when their method is
--    cash, which is what this file enforces.
--
-- 2. engine_close_shift and engine_accounting scope cash sales by store only.
--    Stores are never shared between tenants, so this is not a leak, but it is
--    the kind of assumption that breaks silently later; the tenant is explicit
--    here.

-- --------------------------------------------------------------- ledger
CREATE OR REPLACE FUNCTION public.engine_supplier_ledger(p_supplier uuid)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public AS $$
DECLARE u public.users; s public.suppliers; result jsonb;
BEGIN
  SELECT * INTO u FROM public.current_staff();
  IF u.id IS NULL OR u.role <> 'owner' THEN RAISE EXCEPTION 'للمالك فقط'; END IF;

  SELECT * INTO s FROM public.suppliers WHERE id = p_supplier AND tenant_id = u.tenant_id;
  IF s.id IS NULL THEN RAISE EXCEPTION 'المورد غير موجود'; END IF;

  SELECT jsonb_build_object(
    'supplier', jsonb_build_object('id', s.id, 'name', s.name, 'phone', s.phone,
                                   'supplied_goods', s.supplied_goods, 'totalDebt', coalesce(s.total_debt, 0)),
    -- Invoices received from this supplier.
    'totalPurchases', coalesce((SELECT sum(p.total_amount) FROM public.purchases p
      WHERE p.supplier_id = s.id AND p.tenant_id = u.tenant_id), 0),
    'totalPaid', coalesce((SELECT sum(x.amount) FROM public.supplier_payments x
      WHERE x.supplier_id = s.id
        AND coalesce(x.tenant_id, u.tenant_id) = u.tenant_id), 0),
    'remaining', coalesce(s.total_debt, 0),
    'purchases', coalesce((SELECT jsonb_agg(jsonb_build_object(
        'id', p.id, 'created_at', p.created_at, 'amount', p.total_amount, 'status', p.status
      ) ORDER BY p.created_at DESC)
      FROM public.purchases p WHERE p.supplier_id = s.id AND p.tenant_id = u.tenant_id), '[]'::jsonb),
    'payments', coalesce((SELECT jsonb_agg(jsonb_build_object(
        'id', x.id, 'created_at', x.created_at, 'amount', x.amount,
        'by', coalesce(NULLIF(trim(coalesce(pu.full_name, '')), ''), pu.username)
      ) ORDER BY x.created_at DESC)
      FROM public.supplier_payments x
      LEFT JOIN public.users pu ON pu.id = x.paid_by
      WHERE x.supplier_id = s.id AND coalesce(x.tenant_id, u.tenant_id) = u.tenant_id), '[]'::jsonb)
  ) INTO result;
  RETURN result;
END $$;

-- ------------------------------------------- credit payments: cash only
-- Adds payment_method so non-cash settlements do not inflate the drawer.
ALTER TABLE public.credit_payments ADD COLUMN IF NOT EXISTS payment_method text;
ALTER TABLE public.credit_payments ALTER COLUMN payment_method SET DEFAULT 'cash';
UPDATE public.credit_payments SET payment_method = 'cash' WHERE payment_method IS NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'credit_payments_method_check'
                 AND conrelid = 'public.credit_payments'::regclass)
     AND NOT EXISTS (SELECT 1 FROM public.credit_payments
                     WHERE payment_method IS NOT NULL AND payment_method NOT IN ('cash','check','ccp')) THEN
    ALTER TABLE public.credit_payments
      ADD CONSTRAINT credit_payments_method_check
      CHECK (payment_method IS NULL OR payment_method IN ('cash','check','ccp'));
  END IF;
END $$;

-- Adding a DEFAULT parameter creates an *overload*, not a replacement. The old
-- 3-argument function must go first or PostgREST reports an ambiguous function
-- for any caller that omits the method.
DROP FUNCTION IF EXISTS public.engine_credit_payment(uuid, integer, uuid);

CREATE OR REPLACE FUNCTION public.engine_credit_payment(
  p_credit uuid, p_amount integer, p_request uuid, p_method text DEFAULT 'cash'
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE
  u public.users; c public.credits; s public.shifts; result uuid;
  old_row public.credit_payments; remaining integer; new_status text; customer_name text;
  method text; cash_amount integer;
BEGIN
  SELECT * INTO u FROM public.current_staff();
  IF u.id IS NULL THEN RAISE EXCEPTION 'غير مصرح'; END IF;

  SELECT * INTO c FROM public.credits WHERE id = p_credit FOR UPDATE;
  IF c.id IS NULL THEN RAISE EXCEPTION 'الدين غير موجود'; END IF;
  PERFORM public.engine_validate(c.store_id, u.tenant_id, ARRAY['owner','manager','employee']);

  IF p_amount IS NULL OR p_amount <= 0 THEN RAISE EXCEPTION 'أدخل مبلغاً موجباً'; END IF;
  IF p_amount > 2147483647 THEN RAISE EXCEPTION 'المبلغ كبير جداً'; END IF;
  IF p_request IS NULL THEN RAISE EXCEPTION 'طلب غير صالح'; END IF;
  method := coalesce(nullif(trim(p_method), ''), 'cash');
  IF method NOT IN ('cash','check','ccp') THEN RAISE EXCEPTION 'طريقة دفع غير صالحة'; END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(p_request::text, 0));
  SELECT * INTO old_row FROM public.credit_payments WHERE request_id = p_request;
  IF old_row.id IS NOT NULL THEN
    IF old_row.credit_id <> p_credit OR old_row.amount <> p_amount THEN
      RAISE EXCEPTION 'طلب مكرر ببيانات مختلفة';
    END IF;
    SELECT coalesce(cust.name, '') INTO customer_name FROM public.customers cust WHERE cust.id = c.customer_id;
    RETURN jsonb_build_object('ok', true, 'paymentId', old_row.id, 'replayed', true,
      'customer', customer_name, 'amount', old_row.amount,
      'remaining', (SELECT remaining_amount FROM public.credits WHERE id = p_credit));
  END IF;

  -- Cash can only enter an open drawer. A non-cash settlement still needs an
  -- open shift so it appears in the day's reconciliation, but it must not raise
  -- expected cash above what is physically in the till.
  SELECT * INTO s FROM public.shifts WHERE store_id = c.store_id AND status = 'open' FOR UPDATE;
  IF s.id IS NULL THEN RAISE EXCEPTION 'افتح صندوق الفرع قبل تسجيل الدفعة'; END IF;

  remaining := coalesce(c.remaining_amount, c.total_amount, 0);
  IF p_amount > remaining THEN
    RAISE EXCEPTION 'المبلغ أكبر من المتبقي (%) ', remaining;
  END IF;

  INSERT INTO public.credit_payments(credit_id, store_id, shift_id, amount, created_by, request_id, payment_method)
  VALUES (p_credit, c.store_id, s.id, p_amount, u.id, p_request, method)
  RETURNING id INTO result;

  new_status := CASE WHEN remaining - p_amount <= 0 THEN 'paid' ELSE 'active' END;
  UPDATE public.credits
  SET remaining_amount = remaining - p_amount,
      status = new_status
  WHERE id = p_credit;

  -- Only cash moves the drawer.
  cash_amount := CASE WHEN method = 'cash' THEN p_amount ELSE 0 END;
  IF cash_amount > 0 THEN
    UPDATE public.shifts SET total_credit_payments = total_credit_payments + cash_amount WHERE id = s.id;
  END IF;

  SELECT coalesce(cust.name, '') INTO customer_name FROM public.customers cust WHERE cust.id = c.customer_id;

  RETURN jsonb_build_object(
    'ok', true, 'paymentId', result, 'replayed', false,
    'customer', customer_name, 'amount', p_amount, 'method', method,
    'remaining', remaining - p_amount, 'status', new_status
  );
END $$;

-- ------------------------------------------------------- close the drawer
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
  SELECT coalesce(sum(x.total_amount), 0) INTO sales
    FROM public.sales x JOIN public.stores st ON st.id = x.store_id
   WHERE x.store_id = s.store_id AND st.tenant_id = u.tenant_id
     AND x.payment_method = 'cash' AND x.status = 'completed'
     AND x.created_at >= s.start_time AND x.created_at < now();
  expected := s.expected_cash::bigint + sales - s.total_employee_payments
              + coalesce(s.total_credit_payments, 0);
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

-- --------------------------------------------------------- permissions
REVOKE ALL ON FUNCTION public.engine_supplier_ledger(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.engine_supplier_ledger(uuid) TO authenticated;
REVOKE ALL ON FUNCTION public.engine_credit_payment(uuid, integer, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.engine_credit_payment(uuid, integer, uuid, text) TO authenticated;
REVOKE ALL ON FUNCTION public.engine_close_shift(uuid, integer, bigint, bigint, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.engine_close_shift(uuid, integer, bigint, bigint, text) TO authenticated;
