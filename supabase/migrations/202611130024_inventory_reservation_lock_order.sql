-- Match the variant -> inventory lock order used by sales and transfers.
DO $$
DECLARE d text; marker text := '  PERFORM i.id FROM public.inventory i WHERE i.store_id=o.store_id';
BEGIN
 d:=pg_get_functiondef('public.update_order_status(uuid,text,text)'::regprocedure);
 IF position('PERFORM v.id FROM public.product_variants v WHERE v.id IN' in d)>0 THEN RETURN; END IF;
 IF position(marker in d)=0 THEN RAISE EXCEPTION 'Unexpected reservation lock definition'; END IF;
 d:=replace(d,marker,E'  PERFORM v.id FROM public.product_variants v WHERE v.id IN (SELECT variant_id FROM public.order_items WHERE order_id=o.id) ORDER BY v.id FOR UPDATE;\n' || marker);
 EXECUTE d;
END $$;
