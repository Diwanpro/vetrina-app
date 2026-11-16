-- Standalone post-migration integration regression. Always rolls back.
BEGIN;
SELECT set_config('request.jwt.claim.sub','f1c99bc6-32a1-4f1e-a0fc-a729b602d76d',true);
UPDATE public.stores SET store_enabled=true,hide_products_without_image=false WHERE id='cfd68a7d-410f-405f-99c3-9168ff61965b';
CREATE TEMP TABLE p2_extra(pid uuid,vid uuid,code text);
GRANT SELECT,INSERT,UPDATE ON p2_extra TO authenticated;
SET LOCAL ROLE authenticated;
DO $$ DECLARE p uuid; v uuid; code text:='P2extra-'||gen_random_uuid()::text; BEGIN
 p:=public.engine_create_product_atomic('cfd68a7d-410f-405f-99c3-9168ff61965b','9bdd1045-7f09-427d-bcaa-fdfea3f994f4',jsonb_build_object('name','Public compatibility fixture','base_price',100),jsonb_build_array(jsonb_build_object('quantity',10,'barcodes',jsonb_build_array(jsonb_build_object('barcode',code)))));
 SELECT id INTO STRICT v FROM public.product_variants WHERE product_id=p;
 INSERT INTO p2_extra VALUES(p,v,code);
 UPDATE public.inventory SET reserved_qty=7 WHERE variant_id=v;
 BEGIN INSERT INTO public.product_barcodes(tenant_id,product_id,barcode,barcode_type,is_primary) VALUES('9bdd1045-7f09-427d-bcaa-fdfea3f994f4',p,code||'-MODEL','model',true),('9bdd1045-7f09-427d-bcaa-fdfea3f994f4',p,code||'-MODEL2','model',true); RAISE EXCEPTION 'Multiple model primary allowed'; EXCEPTION WHEN unique_violation THEN NULL; END;
 BEGIN INSERT INTO public.product_barcodes(tenant_id,product_id,variant_id,barcode,barcode_type,is_primary) VALUES('9bdd1045-7f09-427d-bcaa-fdfea3f994f4',p,v,code||'-PRIMARY2','variant',true); RAISE EXCEPTION 'Multiple variant primary allowed'; EXCEPTION WHEN unique_violation THEN NULL; END;
 BEGIN UPDATE public.product_barcodes SET variant_id=gen_random_uuid() WHERE barcode=code; RAISE EXCEPTION 'Mutable variant target'; EXCEPTION WHEN check_violation THEN NULL; END;
 BEGIN UPDATE public.product_barcodes SET tenant_id='fe9e3bf6-72d2-4c85-9e1a-2521e841648e' WHERE barcode=code; RAISE EXCEPTION 'Mutable tenant'; EXCEPTION WHEN check_violation THEN NULL; END;
 BEGIN UPDATE public.product_barcodes SET barcode='bad code' WHERE barcode=code; RAISE EXCEPTION 'Invalid/Mutable value'; EXCEPTION WHEN check_violation THEN NULL; END;
 BEGIN INSERT INTO public.inventory(store_id,variant_id) VALUES('46b6a2cc-8121-4928-ab00-5827bd5dca67',v); RAISE EXCEPTION 'Mixed-tenant inventory'; EXCEPTION WHEN check_violation OR insufficient_privilege THEN NULL; END;
 BEGIN PERFORM public.engine_generate_barcodes('cfd68a7d-410f-405f-99c3-9168ff61965b','9bdd1045-7f09-427d-bcaa-fdfea3f994f4',0); RAISE EXCEPTION 'Invalid count accepted'; EXCEPTION WHEN raise_exception THEN IF SQLERRM<>'Invalid barcode count' THEN RAISE; END IF; END;
END $$;
RESET ROLE;
SET LOCAL ROLE anon;
DO $$ DECLARE data jsonb; BEGIN
 data:=public.get_store_products('cfd68a7d-410f-405f-99c3-9168ff61965b');
 IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(data) x WHERE x->>'name'='Public compatibility fixture' AND (x->'variants'->0->>'available')::integer=3) THEN RAISE EXCEPTION 'Public storefront lost catalog/net availability'; END IF;
 BEGIN PERFORM 1 FROM public.products; RAISE EXCEPTION 'Anonymous raw products'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 BEGIN PERFORM 1 FROM public.product_variants; RAISE EXCEPTION 'Anonymous raw variants'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 BEGIN PERFORM 1 FROM public.inventory; RAISE EXCEPTION 'Anonymous raw inventory'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
END $$;
RESET ROLE;
SET LOCAL ROLE authenticated;
DO $$ DECLARE p uuid; v uuid; code text; BEGIN
 SELECT * INTO p,v,code FROM p2_extra;
 DELETE FROM public.products WHERE id=p;
 IF EXISTS(SELECT 1 FROM public.product_variants WHERE product_id=p) OR EXISTS(SELECT 1 FROM public.product_barcodes WHERE product_id=p) OR EXISTS(SELECT 1 FROM public.inventory WHERE variant_id=v) THEN RAISE EXCEPTION 'Cascade delete failed'; END IF;
END $$;
RESET ROLE;
ROLLBACK;
