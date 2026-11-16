-- Authorized Live acceptance: all fixtures/role changes/sales roll back.
-- Only the already-authorized DDL migration is permanent. No keys needed.
BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='30s';
CREATE TEMP TABLE p3_state(actor uuid,tenant uuid,store uuid,pid uuid,vid uuid,code text);
GRANT SELECT,INSERT,UPDATE ON p3_state TO authenticated;
SET LOCAL ROLE authenticated;
DO $$ DECLARE r record; p uuid; v uuid; c text; n integer; before_count integer; BEGIN
 IF current_user <> 'authenticated' THEN RAISE EXCEPTION 'Invalid test role'; END IF;
 FOR r IN SELECT * FROM (VALUES
 ('f1c99bc6-32a1-4f1e-a0fc-a729b602d76d'::uuid,'9bdd1045-7f09-427d-bcaa-fdfea3f994f4'::uuid,'cfd68a7d-410f-405f-99c3-9168ff61965b'::uuid),
 ('19a090a7-bb67-41f0-893d-b1fe4e7adada'::uuid,'fe9e3bf6-72d2-4c85-9e1a-2521e841648e'::uuid,'46b6a2cc-8121-4928-ab00-5827bd5dca67'::uuid)) x(actor,tenant,store) LOOP
  PERFORM set_config('request.jwt.claim.sub',r.actor::text,true);
  c := 'P3-'||gen_random_uuid()::text;
  p:=public.engine_create_product_atomic(r.store,r.tenant,'{"name":"Phase3 rollback only","base_price":100000}',jsonb_build_array(jsonb_build_object('color','untrusted','color_components',jsonb_build_array('أسود','أبيض'),'size','ONE_SIZE','quantity',10,'barcodes',jsonb_build_array(jsonb_build_object('barcode',c)))),jsonb_build_array(jsonb_build_object('barcode',c||'-MODEL')));
  SELECT id INTO STRICT v FROM public.product_variants WHERE product_id=p AND size='ONE_SIZE' AND color='أبيض / أسود' AND color_components=ARRAY['أبيض','أسود'];
  INSERT INTO p3_state VALUES(r.actor,r.tenant,r.store,p,v,c);
  UPDATE public.inventory SET reserved_qty=7 WHERE variant_id=v AND store_id=r.store;
  BEGIN PERFORM public.engine_sync_sale(r.store,r.tenant,c||'-SALE4',jsonb_build_array(jsonb_build_object('variant_id',v,'quantity',4,'original_price',100000,'final_price',100000)),'cash',now(),NULL); RAISE EXCEPTION 'Reserved stock sold'; EXCEPTION WHEN raise_exception THEN IF SQLERRM NOT LIKE 'المخزون غير كاف%' THEN RAISE; END IF; END;
  PERFORM public.engine_sync_sale(r.store,r.tenant,c||'-SALE3',jsonb_build_array(jsonb_build_object('variant_id',v,'quantity',3,'original_price',100000,'final_price',100000)),'cash',now(),NULL);
  IF NOT EXISTS(SELECT 1 FROM public.inventory WHERE variant_id=v AND store_id=r.store AND quantity=7 AND reserved_qty=7) THEN RAISE EXCEPTION 'Net stock regression'; END IF;
  BEGIN UPDATE public.product_barcodes SET barcode=c||'-CHANGED' WHERE variant_id=v; RAISE EXCEPTION 'Mutable barcode'; EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN UPDATE public.product_barcodes SET variant_id=gen_random_uuid() WHERE variant_id=v; RAISE EXCEPTION 'Mutable target'; EXCEPTION WHEN check_violation THEN NULL; END;
  SELECT count(*) INTO before_count FROM public.products;
  BEGIN PERFORM public.engine_create_product_atomic(r.store,r.tenant,'{"name":"Invalid composite","base_price":1}','[{"color_components":["a","a"],"size":"ONE_SIZE","quantity":1}]'); RAISE EXCEPTION 'Accepted duplicate component'; EXCEPTION WHEN raise_exception THEN IF SQLERRM <> 'Duplicate color component' THEN RAISE; END IF; END;
  BEGIN PERFORM public.engine_create_product_atomic(r.store,r.tenant,'{"name":"Duplicate combination","base_price":1}','[{"color_components":["a","b"],"size":"ONE_SIZE","quantity":1},{"color_components":["b","a"],"size":"ONE_SIZE","quantity":1}]'); RAISE EXCEPTION 'Accepted reversed duplicate'; EXCEPTION WHEN raise_exception THEN IF SQLERRM <> 'Duplicate color/size combination' THEN RAISE; END IF; END;
  BEGIN PERFORM public.engine_create_product_atomic(r.store,r.tenant,'{"name":"Atomic barcode failure","base_price":1}',jsonb_build_array(jsonb_build_object('color_components',jsonb_build_array('a'),'size','ONE_SIZE','quantity',1,'barcodes',jsonb_build_array(jsonb_build_object('barcode',c||'-PARTIAL'))),jsonb_build_object('color_components',jsonb_build_array('b'),'size','ONE_SIZE','quantity',1,'barcodes',jsonb_build_array(jsonb_build_object('barcode',c))))); RAISE EXCEPTION 'Duplicate barcode accepted'; EXCEPTION WHEN unique_violation THEN NULL; END;
  IF before_count<>(SELECT count(*) FROM public.products) OR EXISTS(SELECT 1 FROM public.product_barcodes WHERE barcode=c||'-PARTIAL') THEN RAISE EXCEPTION 'Partial atomic rows'; END IF;
  p:=public.engine_create_product_atomic(r.store,r.tenant,'{"name":"Old payload rollback","base_price":1}',jsonb_build_array(jsonb_build_object('color','legacy / label','size','M','quantity',1,'barcodes',jsonb_build_array(jsonb_build_object('barcode',c||'-OLD')))));
  IF NOT EXISTS(SELECT 1 FROM public.product_variants WHERE product_id=p AND color_components IS NULL AND color='legacy / label') THEN RAISE EXCEPTION 'Old payload broken'; END IF;
 END LOOP;
 FOR r IN SELECT * FROM p3_state LOOP
  PERFORM set_config('request.jwt.claim.sub',r.actor::text,true);
  IF NOT EXISTS(SELECT 1 FROM public.product_variants WHERE id=r.vid) THEN RAISE EXCEPTION 'Own catalog inaccessible'; END IF;
  IF EXISTS(SELECT 1 FROM public.products WHERE tenant_id<>r.tenant) OR EXISTS(SELECT 1 FROM public.product_barcodes WHERE tenant_id<>r.tenant) OR EXISTS(SELECT 1 FROM public.product_variants WHERE id IN (SELECT vid FROM p3_state WHERE tenant<>r.tenant)) OR EXISTS(SELECT 1 FROM public.inventory WHERE variant_id IN (SELECT vid FROM p3_state WHERE tenant<>r.tenant)) THEN RAISE EXCEPTION 'Cross tenant read leak'; END IF;
  UPDATE public.product_variants SET color_components=ARRAY['intrusion'],color='intrusion' WHERE id IN(SELECT vid FROM p3_state WHERE tenant<>r.tenant); GET DIAGNOSTICS n=ROW_COUNT; IF n<>0 THEN RAISE EXCEPTION 'Cross update'; END IF;
  DELETE FROM public.product_variants WHERE id IN(SELECT vid FROM p3_state WHERE tenant<>r.tenant); GET DIAGNOSTICS n=ROW_COUNT; IF n<>0 THEN RAISE EXCEPTION 'Cross delete'; END IF;
  BEGIN INSERT INTO public.product_variants(product_id,color,size,color_components) SELECT pid,'a','ONE_SIZE',ARRAY['a'] FROM p3_state WHERE tenant<>r.tenant; RAISE EXCEPTION 'Cross insert'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  BEGIN PERFORM public.engine_create_product_atomic(s.store,s.tenant,'{"name":"Cross RPC","base_price":1}','[{"quantity":1}]') FROM p3_state s WHERE s.tenant<>r.tenant; RAISE EXCEPTION 'Cross RPC'; EXCEPTION WHEN raise_exception THEN IF SQLERRM NOT LIKE 'غير مصرح%' THEN RAISE; END IF; END;
 END LOOP;
END $$;
RESET ROLE;
UPDATE public.users SET role='employee' WHERE id='f1c99bc6-32a1-4f1e-a0fc-a729b602d76d';
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub','f1c99bc6-32a1-4f1e-a0fc-a729b602d76d',true);
DO $$ DECLARE s record; n integer; BEGIN
 SELECT * INTO STRICT s FROM p3_state WHERE actor=auth.uid();
 IF NOT EXISTS(SELECT 1 FROM public.product_variants WHERE id=s.vid) THEN RAISE EXCEPTION 'Employee read denied'; END IF;
 UPDATE public.product_variants SET color_components=ARRAY['a'],color='a' WHERE id=s.vid; GET DIAGNOSTICS n=ROW_COUNT; IF n<>0 THEN RAISE EXCEPTION 'Employee write'; END IF;
 BEGIN PERFORM public.engine_create_product_atomic(s.store,s.tenant,'{"name":"Employee forbidden","base_price":1}','[{"quantity":1}]'); RAISE EXCEPTION 'Employee RPC'; EXCEPTION WHEN raise_exception THEN IF SQLERRM NOT LIKE 'غير مصرح%' THEN RAISE; END IF; END;
END $$;
RESET ROLE;
UPDATE public.users SET role='manager' WHERE id='f1c99bc6-32a1-4f1e-a0fc-a729b602d76d';
SET LOCAL ROLE authenticated;
DO $$ DECLARE s record; n integer; BEGIN
 SELECT * INTO STRICT s FROM p3_state WHERE actor=auth.uid();
 UPDATE public.inventory SET quantity=quantity WHERE store_id=s.store AND variant_id=s.vid; GET DIAGNOSTICS n=ROW_COUNT; IF n<>1 THEN RAISE EXCEPTION 'Manager own branch denied'; END IF;
 UPDATE public.inventory SET quantity=quantity WHERE store_id<>s.store; GET DIAGNOSTICS n=ROW_COUNT; IF n<>0 THEN RAISE EXCEPTION 'Manager foreign branch'; END IF;
END $$;
RESET ROLE;
SET LOCAL ROLE anon;
DO $$ BEGIN
 BEGIN PERFORM 1 FROM public.product_variants; RAISE EXCEPTION 'Anonymous variants'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 BEGIN PERFORM 1 FROM public.product_barcodes; RAISE EXCEPTION 'Anonymous registry'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 IF has_function_privilege(current_user,'public.engine_create_product_atomic(uuid,uuid,jsonb,jsonb,jsonb)','EXECUTE') THEN RAISE EXCEPTION 'Anonymous RPC'; END IF;
 PERFORM public.get_store_products('cfd68a7d-410f-405f-99c3-9168ff61965b');
END $$;
RESET ROLE;
ROLLBACK;
SELECT 'PASS: Live rollback tests — two tenants, owner/manager/employee/anon, ONE_SIZE composite, legacy payload, immutable barcode, atomic failure, net stock sale3/reject4' AS acceptance;
