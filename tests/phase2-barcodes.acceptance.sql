-- Append after migration 025 inside BEGIN; finish with ROLLBACK.
-- These identities already exist in the test database. Never use service_role
-- as the tested actor: SET ROLE authenticated is intentional.
CREATE TEMP TABLE p2_test_state(a uuid,b uuid,ta uuid,tb uuid,sa uuid,sb uuid,pa uuid,pb uuid,va uuid,vb uuid,token text,collision text);
INSERT INTO p2_test_state(a,b,ta,tb,sa,sb,token,collision)
 SELECT a.auth_id,b.auth_id,a.tenant_id,b.tenant_id,a.store_id,b.store_id,'P2-'||gen_random_uuid()::text,(SELECT (last_value+1)::text FROM public.engine_barcode_numbers)
 FROM public.users a CROSS JOIN public.users b WHERE a.id='f1c99bc6-32a1-4f1e-a0fc-a729b602d76d' AND b.id='2fea6cdc-7f27-4bf0-bfbc-79336889986b';
GRANT SELECT,UPDATE ON p2_test_state TO authenticated;
SET LOCAL ROLE authenticated;
DO $$ DECLARE s record; pid uuid; vid uuid; n integer; before_p integer; before_v integer; before_i integer; before_b integer; codes text[]; z text; r record; old_code text; BEGIN
 SELECT * INTO STRICT s FROM p2_test_state;
 IF current_user<>'authenticated' THEN RAISE EXCEPTION 'RLS test role invalid'; END IF;
 FOR r IN SELECT s.a AS actor,s.ta AS tenant,s.sa AS store,true AS first UNION ALL SELECT s.b,s.tb,s.sb,false LOOP
  PERFORM set_config('request.jwt.claim.sub',r.actor::text,true);
  pid:=public.engine_create_product_atomic(r.store,r.tenant,jsonb_build_object('name','P2 rollback fixture','base_price',100000),jsonb_build_array(jsonb_build_object('color','black','size','M','quantity',10,'barcodes',jsonb_build_array(jsonb_build_object('barcode',s.token)))),jsonb_build_array(jsonb_build_object('barcode',s.token||'-MODEL')));
  SELECT id INTO STRICT vid FROM public.product_variants WHERE product_id=pid;
  IF r.first THEN UPDATE p2_test_state SET pa=pid,va=vid; ELSE UPDATE p2_test_state SET pb=pid,vb=vid; END IF;
 END LOOP;
 SELECT * INTO STRICT s FROM p2_test_state;
 -- Same legacy-column code is legal in two tenants, without changing its value.
 FOR r IN SELECT s.a AS actor,s.ta AS tenant,s.sa AS store,s.tb AS other,s.pb AS foreign_p,s.vb AS foreign_v,s.sb AS foreign_s,s.pa AS own_p,s.va AS own_v UNION ALL SELECT s.b,s.tb,s.sb,s.ta,s.pa,s.va,s.sa,s.pb,s.vb LOOP
  PERFORM set_config('request.jwt.claim.sub',r.actor::text,true);
  IF (SELECT count(*) FROM public.product_barcodes WHERE barcode=s.token)<>1 THEN RAISE EXCEPTION 'Tenant barcode isolation failed'; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.products WHERE id=r.own_p) OR NOT EXISTS(SELECT 1 FROM public.inventory WHERE variant_id=r.own_v) THEN RAISE EXCEPTION 'Own catalog inaccessible'; END IF;
  IF EXISTS(SELECT 1 FROM public.products WHERE tenant_id=r.other) OR EXISTS(SELECT 1 FROM public.product_variants WHERE id=r.foreign_v) OR EXISTS(SELECT 1 FROM public.inventory WHERE variant_id=r.foreign_v) OR EXISTS(SELECT 1 FROM public.product_barcodes WHERE tenant_id=r.other) THEN RAISE EXCEPTION 'Cross-tenant read leak'; END IF;
  IF EXISTS(SELECT 1 FROM public.users WHERE tenant_id=r.other) OR EXISTS(SELECT 1 FROM public.stores WHERE tenant_id=r.other) THEN RAISE EXCEPTION 'Directory leak'; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.users WHERE auth_id=r.actor) OR NOT EXISTS(SELECT 1 FROM public.stores WHERE id=r.store) THEN RAISE EXCEPTION 'Own identity inaccessible'; END IF;
  BEGIN UPDATE public.users SET tenant_id=r.other WHERE auth_id=r.actor; RAISE EXCEPTION 'Staff identity spoof'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  BEGIN UPDATE public.stores SET tenant_id=r.tenant WHERE id=r.foreign_s; RAISE EXCEPTION 'Branch identity spoof'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  BEGIN INSERT INTO public.users(tenant_id,username,role,auth_id) VALUES(r.other,'p2spoof','owner',r.actor); RAISE EXCEPTION 'Staff insertion spoof'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  PERFORM public.engine_session();
  IF has_table_privilege('authenticated','public.users','TRUNCATE') OR has_table_privilege('authenticated','public.stores','TRUNCATE') THEN RAISE EXCEPTION 'Unsafe directory grant'; END IF;
  UPDATE public.products SET name='intrusion' WHERE id=r.foreign_p; GET DIAGNOSTICS n=ROW_COUNT; IF n<>0 THEN RAISE EXCEPTION 'Cross product update'; END IF;
  UPDATE public.product_variants SET size='intrusion' WHERE id=r.foreign_v; GET DIAGNOSTICS n=ROW_COUNT; IF n<>0 THEN RAISE EXCEPTION 'Cross variant update'; END IF;
  UPDATE public.inventory SET quantity=99 WHERE variant_id=r.foreign_v; GET DIAGNOSTICS n=ROW_COUNT; IF n<>0 THEN RAISE EXCEPTION 'Cross inventory update'; END IF;
  UPDATE public.product_barcodes SET is_primary=false WHERE tenant_id=r.other; GET DIAGNOSTICS n=ROW_COUNT; IF n<>0 THEN RAISE EXCEPTION 'Cross barcode update'; END IF;
  DELETE FROM public.products WHERE id=r.foreign_p; GET DIAGNOSTICS n=ROW_COUNT; IF n<>0 THEN RAISE EXCEPTION 'Cross product delete'; END IF;
  DELETE FROM public.product_variants WHERE id=r.foreign_v; GET DIAGNOSTICS n=ROW_COUNT; IF n<>0 THEN RAISE EXCEPTION 'Cross variant delete'; END IF;
  DELETE FROM public.inventory WHERE variant_id=r.foreign_v; GET DIAGNOSTICS n=ROW_COUNT; IF n<>0 THEN RAISE EXCEPTION 'Cross inventory delete'; END IF;
  DELETE FROM public.product_barcodes WHERE tenant_id=r.other; GET DIAGNOSTICS n=ROW_COUNT; IF n<>0 THEN RAISE EXCEPTION 'Cross barcode delete'; END IF;
  BEGIN INSERT INTO public.products(tenant_id,name,base_price) VALUES(r.other,'intrusion',1); RAISE EXCEPTION 'Cross product insert'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  BEGIN INSERT INTO public.product_variants(product_id) VALUES(r.foreign_p); RAISE EXCEPTION 'Cross variant insert'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  BEGIN INSERT INTO public.inventory(store_id,variant_id) VALUES(r.foreign_s,r.foreign_v); RAISE EXCEPTION 'Cross inventory insert'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  BEGIN INSERT INTO public.product_barcodes(tenant_id,product_id,barcode,barcode_type) VALUES(r.other,r.foreign_p,s.token||'-FORGED','model'); RAISE EXCEPTION 'Cross barcode insert'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  BEGIN PERFORM public.engine_create_product_atomic(r.foreign_s,r.other,'{"name":"intrusion","base_price":1}','[{"quantity":1}]'); RAISE EXCEPTION 'Cross RPC accepted'; EXCEPTION WHEN raise_exception THEN IF SQLERRM NOT LIKE 'غير مصرح%' THEN RAISE; END IF; END;
  IF has_table_privilege('authenticated','public.products','TRUNCATE') OR has_table_privilege('authenticated','public.product_variants','TRUNCATE') OR has_table_privilege('authenticated','public.inventory','TRUNCATE') OR has_table_privilege('authenticated','public.product_barcodes','TRUNCATE') THEN RAISE EXCEPTION 'Unsafe truncate grant'; END IF;
 END LOOP;
 PERFORM set_config('request.jwt.claim.sub',s.a::text,true);
 BEGIN INSERT INTO public.product_barcodes(tenant_id,product_id,variant_id,barcode,barcode_type) VALUES(s.ta,s.pa,s.va,s.token,'variant'); RAISE EXCEPTION 'Duplicate accepted'; EXCEPTION WHEN unique_violation THEN NULL; END;
 BEGIN INSERT INTO public.product_barcodes(tenant_id,product_id,barcode,barcode_type) VALUES(s.ta,s.pa,s.token||'-BAD','variant'); RAISE EXCEPTION 'Variant without target'; EXCEPTION WHEN check_violation THEN NULL; END;
 BEGIN INSERT INTO public.product_barcodes(tenant_id,product_id,variant_id,barcode,barcode_type) VALUES(s.ta,s.pa,s.va,s.token||'-BAD','model'); RAISE EXCEPTION 'Model with variant'; EXCEPTION WHEN check_violation THEN NULL; END;
 BEGIN INSERT INTO public.product_barcodes(tenant_id,product_id,barcode,barcode_type) VALUES(s.ta,s.pb,s.token||'-BAD','model'); RAISE EXCEPTION 'Foreign product with own tenant'; EXCEPTION WHEN foreign_key_violation THEN NULL; END;
 BEGIN INSERT INTO public.product_barcodes(tenant_id,product_id,variant_id,barcode,barcode_type) VALUES(s.ta,s.pa,s.vb,s.token||'-BAD','variant'); RAISE EXCEPTION 'Foreign variant with own product'; EXCEPTION WHEN foreign_key_violation THEN NULL; END;
 BEGIN UPDATE public.products SET tenant_id=s.tb WHERE id=s.pa; RAISE EXCEPTION 'Product moved tenant'; EXCEPTION WHEN check_violation THEN NULL; END;
 BEGIN UPDATE public.product_variants SET product_id=s.pb WHERE id=s.va; RAISE EXCEPTION 'Variant moved product'; EXCEPTION WHEN check_violation THEN NULL; END;
 BEGIN UPDATE public.product_barcodes SET barcode=s.token||'-CHANGED' WHERE variant_id=s.va; RAISE EXCEPTION 'Mutable barcode'; EXCEPTION WHEN check_violation THEN NULL; END;
 BEGIN UPDATE public.product_barcodes SET product_id=s.pb WHERE variant_id=s.va; RAISE EXCEPTION 'Retargeted barcode'; EXCEPTION WHEN check_violation THEN NULL; END;
 BEGIN UPDATE public.product_variants SET barcode=s.token||'-CHANGED' WHERE id=s.va; RAISE EXCEPTION 'Legacy mutation'; EXCEPTION WHEN check_violation THEN NULL; END;
 -- Multiple aliases; delete/create works, historical assignment cannot be stolen.
 INSERT INTO public.product_barcodes(tenant_id,product_id,variant_id,barcode,barcode_type) VALUES(s.ta,s.pa,s.va,s.token||'-ALIAS','variant');
 DELETE FROM public.product_barcodes WHERE variant_id=s.va AND barcode=s.token;
 IF (SELECT barcode FROM public.product_variants WHERE id=s.va) IS NOT NULL THEN RAISE EXCEPTION 'Deleted legacy still scanned'; END IF;
 INSERT INTO public.product_barcodes(tenant_id,product_id,variant_id,barcode,barcode_type,is_primary) VALUES(s.ta,s.pa,s.va,s.token||'-NEW','variant',true);
 BEGIN INSERT INTO public.product_barcodes(tenant_id,product_id,barcode,barcode_type) VALUES(s.ta,s.pa,s.token,'model'); RAISE EXCEPTION 'Deleted code reassigned'; EXCEPTION WHEN unique_violation THEN NULL; END;
 -- Legacy direct insert remains supported and tenant uniqueness is enforced.
 INSERT INTO public.product_variants(product_id,color,size,barcode) VALUES(s.pa,'white','L',s.token||'-OLDCLIENT') RETURNING id INTO vid;
 IF NOT EXISTS(SELECT 1 FROM public.product_barcodes WHERE variant_id=vid AND barcode_source='legacy') THEN RAISE EXCEPTION 'Legacy bridge failed'; END IF;
 BEGIN INSERT INTO public.product_variants(product_id,barcode) VALUES(s.pa,s.token||'-OLDCLIENT'); RAISE EXCEPTION 'Legacy duplicate accepted'; EXCEPTION WHEN unique_violation THEN NULL; END;
 -- Force the next sequence candidate to collide with a MODEL-only barcode.
 INSERT INTO public.product_barcodes(tenant_id,product_id,barcode,barcode_type) VALUES(s.ta,s.pa,s.collision,'model');
 codes:=public.engine_generate_barcodes(s.sa,s.ta,2);
 IF cardinality(codes)<>2 OR codes[1]=codes[2] OR s.collision=ANY(codes) THEN RAISE EXCEPTION 'Generator collision handling'; END IF;
 IF codes && public.engine_generate_barcodes(s.sa,s.ta,2) THEN RAISE EXCEPTION 'Generator reused reservation'; END IF;
 SELECT count(*) INTO before_p FROM public.products; SELECT count(*) INTO before_v FROM public.product_variants; SELECT count(*) INTO before_i FROM public.inventory; SELECT count(*) INTO before_b FROM public.product_barcodes;
 BEGIN
  PERFORM public.engine_create_product_atomic(s.sa,s.ta,'{"name":"Must rollback","base_price":1}',jsonb_build_array(jsonb_build_object('quantity',1,'barcodes',jsonb_build_array(jsonb_build_object('barcode',s.token||'-TX1'))),jsonb_build_object('quantity',2,'barcodes',jsonb_build_array(jsonb_build_object('barcode',s.token||'-OLDCLIENT')))));
  RAISE EXCEPTION 'Atomic failure not raised';
 EXCEPTION WHEN unique_violation THEN NULL; END;
 IF before_p<>(SELECT count(*) FROM public.products) OR before_v<>(SELECT count(*) FROM public.product_variants) OR before_i<>(SELECT count(*) FROM public.inventory) OR before_b<>(SELECT count(*) FROM public.product_barcodes) THEN RAISE EXCEPTION 'Partial atomic product remains'; END IF;
 pid:=public.engine_create_product_atomic(s.sa,s.ta,'{"name":"Generated atomic","base_price":100000}','[{"quantity":10,"color":"blue","size":"M"}]');
 IF (SELECT count(*) FROM public.product_barcodes WHERE product_id=pid AND barcode_source='generated')<>1 THEN RAISE EXCEPTION 'Generated atomic product failed'; END IF;
 -- Phase 1 reservation regression through existing sale engine, no UI changes.
 SELECT id INTO STRICT vid FROM public.product_variants WHERE product_id=pid;
 UPDATE public.inventory SET reserved_qty=7 WHERE variant_id=vid AND store_id=s.sa;
 BEGIN PERFORM public.engine_sync_sale(s.sa,s.ta,s.token||'-SALE4',jsonb_build_array(jsonb_build_object('variant_id',vid,'quantity',4,'original_price',100000,'final_price',100000)),'cash',now(),NULL); RAISE EXCEPTION 'Reserved stock sold'; EXCEPTION WHEN raise_exception THEN IF SQLERRM NOT LIKE 'المخزون غير كاف%' THEN RAISE; END IF; END;
 PERFORM public.engine_sync_sale(s.sa,s.ta,s.token||'-SALE3',jsonb_build_array(jsonb_build_object('variant_id',vid,'quantity',3,'original_price',100000,'final_price',100000)),'cash',now(),NULL);
 IF NOT EXISTS(SELECT 1 FROM public.inventory WHERE variant_id=vid AND store_id=s.sa AND quantity=7 AND reserved_qty=7) THEN RAISE EXCEPTION 'Sale3 regression'; END IF;
END $$;
RESET ROLE;
-- employee and branch-manager authorization, still using real auth identities.
UPDATE public.users SET role='employee' WHERE id='f1c99bc6-32a1-4f1e-a0fc-a729b602d76d';
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub',(SELECT a::text FROM p2_test_state),true);
DO $$ DECLARE s record; n integer; BEGIN
 SELECT * INTO s FROM p2_test_state;
 IF NOT EXISTS(SELECT 1 FROM public.products WHERE id=s.pa) THEN RAISE EXCEPTION 'Employee cannot read own catalog'; END IF;
 BEGIN INSERT INTO public.products(tenant_id,name,base_price) VALUES(s.ta,'employee write',1); RAISE EXCEPTION 'Employee write allowed'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 BEGIN PERFORM public.engine_create_product_atomic(s.sa,s.ta,'{"name":"employee RPC","base_price":1}','[{"quantity":1}]'); RAISE EXCEPTION 'Employee RPC allowed'; EXCEPTION WHEN raise_exception THEN IF SQLERRM NOT LIKE 'غير مصرح%' THEN RAISE; END IF; END;
END $$;
RESET ROLE;
UPDATE public.users SET role='manager' WHERE id='f1c99bc6-32a1-4f1e-a0fc-a729b602d76d';
SET LOCAL ROLE authenticated;
DO $$ DECLARE s record; n integer; BEGIN
 SELECT * INTO s FROM p2_test_state;
 UPDATE public.inventory SET quantity=quantity WHERE store_id=s.sa AND variant_id=s.va; GET DIAGNOSTICS n=ROW_COUNT;
 IF n<>1 THEN RAISE EXCEPTION 'Manager assigned branch write denied'; END IF;
 UPDATE public.inventory SET quantity=quantity WHERE store_id<>s.sa; GET DIAGNOSTICS n=ROW_COUNT;
 IF n<>0 THEN RAISE EXCEPTION 'Manager other branch write allowed'; END IF;
END $$;
RESET ROLE;
SET LOCAL ROLE anon;
DO $$ BEGIN
 BEGIN PERFORM 1 FROM public.product_barcodes LIMIT 1; RAISE EXCEPTION 'Anonymous raw registry read'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 PERFORM public.get_store_products('cfd68a7d-410f-405f-99c3-9168ff61965b');
END $$;
RESET ROLE;
SELECT 'PASS: two-tenant CRUD isolation, immutable identities, legacy bridge, aliases, generator collisions, atomic rollback, employee/manager permissions, anon storefront, Phase1 sale10/7' AS acceptance;
