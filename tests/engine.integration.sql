-- Run with a database administration connection against a test project.
-- Requires an existing active owner linked to auth_id and a store.
-- All fixtures and business writes are rolled back. Never remove the rollback.
BEGIN;
CREATE TEMP TABLE engine_test_context AS
  SELECT u.tenant_id,u.auth_id,
    coalesce(u.store_id,(SELECT s.id FROM public.stores s WHERE s.tenant_id=u.tenant_id LIMIT 1)) AS store_id
  FROM public.users u WHERE u.role='owner' AND u.auth_id IS NOT NULL AND coalesce(u.is_active,true) LIMIT 1;
GRANT SELECT ON engine_test_context TO authenticated;
SELECT set_config('request.jwt.claim.sub',(SELECT auth_id::text FROM engine_test_context),true);
SET LOCAL ROLE authenticated;
DO $$
DECLARE ctx record; supplier uuid; product uuid; variant uuid; receipt uuid; again uuid;
  request uuid := gen_random_uuid(); pay_request uuid := gen_random_uuid(); payload jsonb;
  qty integer; avg_cost numeric; debt integer; before_count integer; caught boolean;
BEGIN
  SELECT * INTO ctx FROM engine_test_context;
  IF ctx.store_id IS NULL THEN RAISE EXCEPTION 'No owner/store fixture available'; END IF;
  supplier := public.engine_add_supplier(ctx.store_id,ctx.tenant_id,'__engine_rollback_test__','','test');
  IF NOT EXISTS (SELECT 1 FROM public.suppliers WHERE id=supplier) THEN RAISE EXCEPTION 'Scoped supplier read failed'; END IF;
  INSERT INTO public.products(tenant_id,name,base_price) VALUES(ctx.tenant_id,'__engine_rollback_test__',100) RETURNING id INTO product;
  INSERT INTO public.product_variants(product_id,size,color,cost_price_avg) VALUES(product,'TEST','TEST',50) RETURNING id INTO variant;
  payload := jsonb_build_array(jsonb_build_object('variant_id',variant,'quantity',10,'unit_cost',100));
  receipt := public.engine_receive_purchase(ctx.store_id,ctx.tenant_id,supplier,payload,request);
  again := public.engine_receive_purchase(ctx.store_id,ctx.tenant_id,supplier,payload,request);
  IF receipt IS DISTINCT FROM again THEN RAISE EXCEPTION 'Idempotency failed'; END IF;
  SELECT quantity INTO qty FROM public.inventory WHERE variant_id=variant AND store_id=ctx.store_id;
  SELECT cost_price_avg INTO avg_cost FROM public.product_variants WHERE id=variant;
  SELECT total_debt INTO debt FROM public.suppliers WHERE id=supplier;
  IF qty<>10 OR avg_cost<>100 OR debt<>1000 THEN RAISE EXCEPTION 'Initial receipt incorrect'; END IF;
  PERFORM public.engine_receive_purchase(ctx.store_id,ctx.tenant_id,supplier,jsonb_build_array(jsonb_build_object('variant_id',variant,'quantity',5,'unit_cost',200)),gen_random_uuid());
  SELECT cost_price_avg INTO avg_cost FROM public.product_variants WHERE id=variant;
  IF abs(avg_cost-(2000::numeric/15))>0.000001 THEN RAISE EXCEPTION 'Weighted cost failed'; END IF;
  PERFORM public.engine_pay_supplier(ctx.store_id,ctx.tenant_id,supplier,100,pay_request);
  PERFORM public.engine_pay_supplier(ctx.store_id,ctx.tenant_id,supplier,100,pay_request);
  SELECT total_debt INTO debt FROM public.suppliers WHERE id=supplier;
  IF debt<>1900 THEN RAISE EXCEPTION 'Payment/idempotency failed'; END IF;
  caught := false;
  BEGIN PERFORM public.engine_pay_supplier(ctx.store_id,ctx.tenant_id,supplier,1901,gen_random_uuid());
  EXCEPTION WHEN OTHERS THEN caught:=true; END;
  IF NOT caught THEN RAISE EXCEPTION 'Overpayment should fail'; END IF;
  SELECT count(*) INTO before_count FROM public.purchases WHERE supplier_id=supplier;
  caught := false;
  BEGIN
    PERFORM public.engine_receive_purchase(ctx.store_id,ctx.tenant_id,supplier,jsonb_build_array(jsonb_build_object('variant_id',variant,'quantity',1,'unit_cost',100),jsonb_build_object('variant_id',gen_random_uuid(),'quantity',1,'unit_cost',100)),gen_random_uuid());
  EXCEPTION WHEN OTHERS THEN caught:=true; END;
  IF NOT caught OR (SELECT count(*) FROM public.purchases WHERE supplier_id=supplier)<>before_count THEN RAISE EXCEPTION 'Failed receipt did not roll back'; END IF;
  SELECT quantity INTO qty FROM public.inventory WHERE variant_id=variant AND store_id=ctx.store_id;
  IF qty<>15 THEN RAISE EXCEPTION 'Failed receipt changed stock'; END IF;
  caught:=false;
  BEGIN PERFORM public.engine_add_supplier(ctx.store_id,gen_random_uuid(),'invalid','','');
  EXCEPTION WHEN OTHERS THEN caught:=true; END;
  IF NOT caught THEN RAISE EXCEPTION 'Foreign tenant accepted'; END IF;
  caught:=false;
  BEGIN INSERT INTO public.suppliers(name,total_debt,tenant_id,store_id) VALUES('direct',999,ctx.tenant_id,ctx.store_id);
  EXCEPTION WHEN insufficient_privilege THEN caught:=true; END;
  IF NOT caught THEN RAISE EXCEPTION 'Direct financial write should fail'; END IF;
  PERFORM set_config('request.jwt.claim.sub','',true);
  caught:=false;
  BEGIN PERFORM public.engine_add_supplier(ctx.store_id,ctx.tenant_id,'unauthenticated','','');
  EXCEPTION WHEN OTHERS THEN caught:=true; END;
  IF NOT caught THEN RAISE EXCEPTION 'Unauthenticated RPC accepted'; END IF;
  IF EXISTS (SELECT 1 FROM public.suppliers WHERE id=supplier) THEN RAISE EXCEPTION 'Unauthenticated read leaked supplier'; END IF;
END $$;
ROLLBACK;
