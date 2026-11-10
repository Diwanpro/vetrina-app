-- Pin the author through uploads/account changes, as done for offline sales.
CREATE FUNCTION public.engine_record_expense_for_staff(p_store uuid,p_amount integer,p_description text,p_receipt text,p_request uuid,p_staff uuid) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE u public.users;
BEGIN
 SELECT * INTO u FROM public.current_staff();
 IF u.id IS NULL OR u.id IS DISTINCT FROM p_staff THEN RAISE EXCEPTION 'تغير حساب المستخدم. أعد تسجيل المصروف من الحساب الصحيح'; END IF;
 RETURN public.engine_record_expense(p_store,p_amount,p_description,p_receipt,p_request);
END $$;
REVOKE EXECUTE ON FUNCTION public.engine_record_expense(uuid,integer,text,text,uuid) FROM authenticated;
REVOKE ALL ON FUNCTION public.engine_record_expense_for_staff(uuid,integer,text,text,uuid,uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.engine_record_expense_for_staff(uuid,integer,text,text,uuid,uuid) TO authenticated;
