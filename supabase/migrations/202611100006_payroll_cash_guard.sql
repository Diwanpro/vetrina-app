-- Guard against impossible negative drawer balances without duplicating expenses.
DO $migration$
DECLARE body text;
BEGIN
 SELECT pg_get_functiondef('public.engine_employee_payment(uuid,text,integer,text,uuid)'::regprocedure) INTO body;
 body:=regexp_replace(body, 'IF p_kind=''advance'' THEN[[:space:]]+INSERT', 'IF s.expected_cash::bigint + (SELECT coalesce(sum(total_amount),0) FROM public.sales WHERE store_id=s.store_id AND payment_method=''cash'' AND status=''completed'' AND created_at>=s.start_time AND created_at<=clock_timestamp()) - s.total_employee_payments < p_amount THEN RAISE EXCEPTION ''النقد المتاح في الصندوق غير كافٍ''; END IF; IF p_kind=''advance'' THEN INSERT');
 IF position('النقد المتاح' in body)=0 THEN RAISE EXCEPTION 'Payment guard patch not applied'; END IF;
 EXECUTE body;
END $migration$;
