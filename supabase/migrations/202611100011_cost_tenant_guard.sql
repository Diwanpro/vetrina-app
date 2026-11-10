-- Legacy inconsistent variant references must not read another tenant's cost.
DO $$ DECLARE body text; BEGIN
 SELECT pg_get_functiondef('public.engine_accounting_commercial(uuid,timestamptz,timestamptz)'::regprocedure) INTO body;
 body:=replace(body,'LEFT JOIN public.product_variants v ON v.id=i.variant_id WHERE', 'LEFT JOIN public.product_variants v ON v.id=i.variant_id AND EXISTS(SELECT 1 FROM public.products p WHERE p.id=v.product_id AND p.tenant_id=u.tenant_id) WHERE');
 IF position('p.tenant_id=u.tenant_id' in body)=0 THEN RAISE EXCEPTION 'Cost scope patch not applied'; END IF; EXECUTE body;
END $$;
