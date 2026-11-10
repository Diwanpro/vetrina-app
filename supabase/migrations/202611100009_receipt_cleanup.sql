-- Security-definer lookup prevents existing expense RLS hiding attached receipts
-- from the cleanup guard. Does not change any application table policy.
CREATE FUNCTION public.engine_receipt_unattached(p_path text) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public AS $$ SELECT public.engine_receipt_access(p_path,true) AND NOT EXISTS(SELECT 1 FROM public.expenses WHERE receipt_url=p_path) $$;
REVOKE ALL ON FUNCTION public.engine_receipt_unattached(text) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.engine_receipt_unattached(text) TO authenticated;
ALTER POLICY expense_receipt_cleanup ON storage.objects USING(bucket_id='expense-receipts' AND public.engine_receipt_unattached(name));
