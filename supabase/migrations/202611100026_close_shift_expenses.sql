-- 026: expected cash includes drawer expenses, and one place computes it
--
-- Two bugs this closes:
--
-- 1. `engine_close_shift` never subtracted expenses paid from the drawer, so a
--    shift that bought anything from petty cash could not be balanced. The
--    client did not subtract them either, so both sides agreed on a wrong
--    number and the shortfall showed up as a mystery difference.
-- 2. The client computed expected cash in `components/dashboard/ShiftManager.js`
--    while the server recomputed it here, and the two drifted: the client
--    omitted settled credit and cleared cheques, so any shift containing either
--    failed to close with "تغير الصندوق".
--
-- The formula now lives in exactly two mirrored places, `lib/cash.js`
-- (`expectedCash`) and this function, and a test asserts they agree.
--
-- Refunds are not implemented in the schema yet. When they are, they are a
-- subtraction here alongside expenses.
--
-- Apply after 025. Idempotent.

CREATE OR REPLACE FUNCTION public.engine_close_shift(
  p_shift uuid, p_actual integer, p_expected bigint, p_difference bigint, p_notes text
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE u public.users; s public.shifts; sales bigint; spent bigint; expected bigint;
BEGIN
  SELECT * INTO u FROM public.current_staff();
  SELECT * INTO s FROM public.shifts WHERE id = p_shift FOR UPDATE;
  PERFORM public.engine_validate(s.store_id, u.tenant_id, ARRAY['owner','manager','employee']);
  IF s.id IS NULL OR s.status <> 'open' THEN RAISE EXCEPTION 'الوردية مغلقة'; END IF;

  -- Cash actually taken, not the invoice total: the cheque or credit part of a
  -- mixed ticket never entered the drawer.
  SELECT coalesce(sum(x.cash_amount), 0) INTO sales
    FROM public.sales x JOIN public.stores st ON st.id = x.store_id
   WHERE x.store_id = s.store_id AND st.tenant_id = u.tenant_id
     AND x.status = 'completed'
     AND x.created_at >= s.start_time AND x.created_at < now();

  -- Money that left the drawer during the shift.
  SELECT coalesce(sum(x.amount), 0) INTO spent
    FROM public.expenses x JOIN public.stores st ON st.id = x.store_id
   WHERE x.store_id = s.store_id AND st.tenant_id = u.tenant_id
     AND x.deleted_at IS NULL
     AND x.created_at >= s.start_time AND x.created_at < now();

  expected := s.expected_cash::bigint + sales - s.total_employee_payments
              + coalesce(s.total_credit_payments, 0) + coalesce(s.total_collections, 0)
              - spent;

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

REVOKE ALL ON FUNCTION public.engine_close_shift(uuid, integer, bigint, bigint, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.engine_close_shift(uuid, integer, bigint, bigint, text) TO authenticated;

-- Total outstanding credit for the dashboard KPI, tenant-scoped and computed
-- server-side so the browser never has to page through every debt row.
CREATE OR REPLACE FUNCTION public.engine_total_credit(p_store uuid DEFAULT NULL)
RETURNS bigint
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public AS $$
DECLARE u public.users; total bigint;
BEGIN
  SELECT * INTO u FROM public.current_staff();
  IF u.id IS NULL THEN RAISE EXCEPTION 'غير مصرح'; END IF;
  IF p_store IS NOT NULL THEN PERFORM public.engine_validate(p_store, u.tenant_id, ARRAY['owner','manager','employee']); END IF;
  SELECT coalesce(sum(c.remaining_amount), 0) INTO total
    FROM public.credits c
    JOIN public.customers cust ON cust.id = c.customer_id
   WHERE cust.tenant_id = u.tenant_id
     AND (p_store IS NULL OR c.store_id = p_store)
     AND c.status <> 'paid'
     AND c.remaining_amount > 0;
  RETURN total;
END $$;

REVOKE ALL ON FUNCTION public.engine_total_credit(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.engine_total_credit(uuid) TO authenticated;
