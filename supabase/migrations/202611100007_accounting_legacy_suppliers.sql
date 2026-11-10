-- Include old payments that predate explicit store/tenant fields when their
-- supplier provides a safe tenant/branch attribution. Never guess unowned rows.
DO $migration$
DECLARE body text;
BEGIN
 SELECT pg_get_functiondef('public.engine_accounting(uuid,timestamptz,timestamptz)'::regprocedure) INTO body;
 body:=replace(body,
 'FROM public.supplier_payments x JOIN public.stores s ON s.id=x.store_id WHERE s.tenant_id=u.tenant_id',
 'FROM public.supplier_payments x LEFT JOIN public.suppliers supplier ON supplier.id=x.supplier_id LEFT JOIN public.stores s ON s.id=coalesce(x.store_id,supplier.store_id) WHERE coalesce(x.tenant_id,supplier.tenant_id,s.tenant_id)=u.tenant_id AND (s.tenant_id IS NULL OR s.tenant_id=u.tenant_id)');
 IF position('supplier.store_id' in body)=0 THEN RAISE EXCEPTION 'Legacy accounting patch not applied'; END IF;
 EXECUTE body;
END $migration$;
