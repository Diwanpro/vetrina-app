-- Run with a database administration connection and an active owner fixture.
-- Business writes roll back, but reserved barcode sequence numbers do not.
BEGIN;
DO $$
DECLARE u public.users; s uuid; supplier uuid; product uuid; variant uuid;
  receipt uuid; again uuid; request uuid := gen_random_uuid(); payload jsonb;
  codes text[]; more_codes text[]; description_value text; caught boolean; before_count integer;
BEGIN
  SELECT * INTO u FROM public.users WHERE role='owner' AND auth_id IS NOT NULL AND coalesce(is_active,true) LIMIT 1;
  IF u.id IS NULL THEN RAISE EXCEPTION 'No owner fixture'; END IF;
  SELECT id INTO s FROM public.stores WHERE tenant_id=u.tenant_id AND (u.store_id IS NULL OR id=u.store_id) LIMIT 1;
  PERFORM set_config('request.jwt.claim.sub',u.auth_id::text,true);
  codes := public.engine_generate_barcodes(s,u.tenant_id,3);
  more_codes := public.engine_generate_barcodes(s,u.tenant_id,3);
  IF cardinality(codes)<>3 OR EXISTS (SELECT 1 FROM unnest(codes||more_codes) AS x(code) WHERE code !~ '^[0-9]{12}$')
    OR (SELECT count(DISTINCT code) FROM unnest(codes||more_codes) AS x(code))<>6
    THEN RAISE EXCEPTION 'Barcode format/uniqueness failed'; END IF;
  supplier := public.engine_add_supplier(s,u.tenant_id,'__merchant_ux_rollback_test__','',E'سراويل: جينز، تشينو\nأحذية: رياضية');
  IF (SELECT supplied_goods FROM public.suppliers WHERE id=supplier) IS DISTINCT FROM E'سراويل: جينز، تشينو\nأحذية: رياضية' THEN RAISE EXCEPTION 'Supplier newlines lost'; END IF;
  INSERT INTO public.products(tenant_id,name,base_price) VALUES(u.tenant_id,'__merchant_ux_rollback_test__',100) RETURNING id INTO product;
  INSERT INTO public.product_variants(product_id,size,color,barcode,cost_price_avg) VALUES(product,'40','أسود',codes[1],50) RETURNING id INTO variant;
  payload := jsonb_build_array(jsonb_build_object('variant_id',variant,'quantity',3,'unit_cost',100));
  receipt := public.engine_receive_purchase_with_description(s,u.tenant_id,supplier,payload,request,E'  سلسلة جينز\nأسود  ');
  again := public.engine_receive_purchase_with_description(s,u.tenant_id,supplier,payload,request,E'سلسلة جينز\nأسود');
  SELECT description INTO description_value FROM public.purchases WHERE id=receipt;
  IF receipt IS DISTINCT FROM again OR description_value IS DISTINCT FROM E'سلسلة جينز\nأسود' THEN RAISE EXCEPTION 'Description persistence/idempotency failed'; END IF;
  IF (SELECT quantity FROM public.inventory WHERE variant_id=variant AND store_id=s)<>3 THEN RAISE EXCEPTION 'Retry doubled stock'; END IF;
  caught := false;
  BEGIN PERFORM public.engine_receive_purchase_with_description(s,u.tenant_id,supplier,payload,request,'different'); EXCEPTION WHEN OTHERS THEN caught:=true; END;
  IF NOT caught THEN RAISE EXCEPTION 'Changed retry description accepted'; END IF;
  SELECT count(*) INTO before_count FROM public.purchases WHERE supplier_id=supplier;
  caught:=false;
  BEGIN PERFORM public.engine_receive_purchase_with_description(s,u.tenant_id,supplier,payload,gen_random_uuid(),repeat('x',4001)); EXCEPTION WHEN OTHERS THEN caught:=true; END;
  IF NOT caught OR (SELECT count(*) FROM public.purchases WHERE supplier_id=supplier)<>before_count THEN RAISE EXCEPTION 'Invalid description created receipt'; END IF;
END $$;
ROLLBACK;
