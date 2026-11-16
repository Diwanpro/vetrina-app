-- Phase 2 / database only. Run transactionally; no frontend integration here.
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '60s';
LOCK TABLE public.products, public.product_variants, public.inventory IN SHARE ROW EXCLUSIVE MODE;

ALTER TABLE public.products ADD CONSTRAINT products_id_tenant_p2 UNIQUE(id, tenant_id);
ALTER TABLE public.product_variants ADD CONSTRAINT variants_id_product_p2 UNIQUE(id, product_id);
CREATE SCHEMA IF NOT EXISTS barcode_internal;
REVOKE ALL ON SCHEMA barcode_internal FROM PUBLIC, anon, authenticated;
-- Reservations also retain historical ownership after deletion: a printed code
-- can be removed, but cannot subsequently identify another target in that tenant.
CREATE TABLE barcode_internal.claims (
 tenant_id uuid NOT NULL REFERENCES public.tenants(id), barcode text NOT NULL,
 product_id uuid, variant_id uuid, barcode_type text,
 PRIMARY KEY(tenant_id, barcode)
);
REVOKE ALL ON barcode_internal.claims FROM PUBLIC, anon, authenticated;
CREATE TABLE public.product_barcodes (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id uuid NOT NULL REFERENCES public.tenants(id),
 product_id uuid NOT NULL, variant_id uuid,
 barcode text NOT NULL CHECK(barcode ~ '^[!-~]{1,64}$'),
 barcode_type text NOT NULL CHECK(barcode_type IN ('model','variant')),
 barcode_source text NOT NULL DEFAULT 'manual' CHECK(barcode_source IN ('legacy','manual','generated','import')),
 is_primary boolean NOT NULL DEFAULT false,
 created_at timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT product_barcodes_tenant_code_key UNIQUE(tenant_id,barcode),
 CONSTRAINT product_barcodes_shape CHECK((barcode_type='model' AND variant_id IS NULL) OR (barcode_type='variant' AND variant_id IS NOT NULL)),
 CONSTRAINT product_barcodes_product_tenant_fk FOREIGN KEY(product_id,tenant_id) REFERENCES public.products(id,tenant_id) ON DELETE CASCADE,
 CONSTRAINT product_barcodes_variant_product_fk FOREIGN KEY(variant_id,product_id) REFERENCES public.product_variants(id,product_id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX product_barcodes_primary_model ON public.product_barcodes(product_id) WHERE is_primary AND barcode_type='model';
CREATE UNIQUE INDEX product_barcodes_primary_variant ON public.product_barcodes(variant_id) WHERE is_primary AND barcode_type='variant';
CREATE INDEX product_barcodes_product_idx ON public.product_barcodes(product_id);
CREATE INDEX product_barcodes_variant_idx ON public.product_barcodes(variant_id);

CREATE FUNCTION public.p2_barcode_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE c barcode_internal.claims;
BEGIN
 IF TG_OP='UPDATE' AND ROW(NEW.id,NEW.tenant_id,NEW.product_id,NEW.variant_id,NEW.barcode,NEW.barcode_type,NEW.barcode_source,NEW.created_at) IS DISTINCT FROM ROW(OLD.id,OLD.tenant_id,OLD.product_id,OLD.variant_id,OLD.barcode,OLD.barcode_type,OLD.barcode_source,OLD.created_at) THEN
  RAISE EXCEPTION 'Barcode identity is immutable; delete and create a different code' USING ERRCODE='23514';
 END IF;
 IF TG_OP='INSERT' THEN
  INSERT INTO barcode_internal.claims(tenant_id,barcode) VALUES(NEW.tenant_id,NEW.barcode) ON CONFLICT DO NOTHING;
  SELECT * INTO c FROM barcode_internal.claims WHERE tenant_id=NEW.tenant_id AND barcode=NEW.barcode FOR UPDATE;
  IF c.product_id IS NOT NULL AND ROW(c.product_id,c.variant_id,c.barcode_type) IS DISTINCT FROM ROW(NEW.product_id,NEW.variant_id,NEW.barcode_type) THEN
   RAISE EXCEPTION 'Barcode was previously assigned to another target' USING ERRCODE='23505';
  END IF;
  UPDATE barcode_internal.claims SET product_id=NEW.product_id,variant_id=NEW.variant_id,barcode_type=NEW.barcode_type WHERE tenant_id=NEW.tenant_id AND barcode=NEW.barcode;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER barcode_identity_guard BEFORE INSERT OR UPDATE ON public.product_barcodes FOR EACH ROW EXECUTE FUNCTION public.p2_barcode_guard();
INSERT INTO public.product_barcodes(tenant_id,product_id,variant_id,barcode,barcode_type,barcode_source,is_primary)
 SELECT p.tenant_id,v.product_id,v.id,v.barcode,'variant','legacy',true FROM public.product_variants v JOIN public.products p ON p.id=v.product_id WHERE v.barcode IS NOT NULL;
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM public.product_variants v JOIN public.products p ON p.id=v.product_id LEFT JOIN public.product_barcodes b ON b.tenant_id=p.tenant_id AND b.barcode=v.barcode AND b.variant_id=v.id WHERE v.barcode IS NOT NULL AND b.id IS NULL) THEN RAISE EXCEPTION 'Incomplete legacy backfill'; END IF;
END $$;
-- Tenant uniqueness now comes from the registry, including legacy direct inserts.
ALTER TABLE public.product_variants DROP CONSTRAINT product_variants_barcode_key;
CREATE INDEX product_variants_barcode_lookup ON public.product_variants(barcode);
CREATE FUNCTION public.p2_parent_identity_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
 IF TG_TABLE_NAME='products' THEN
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id THEN RAISE EXCEPTION 'Product ownership is immutable' USING ERRCODE='23514'; END IF;
 ELSE
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.product_id IS DISTINCT FROM OLD.product_id THEN RAISE EXCEPTION 'Variant ownership is immutable' USING ERRCODE='23514'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER product_owner_guard BEFORE UPDATE ON public.products FOR EACH ROW EXECUTE FUNCTION public.p2_parent_identity_guard();
CREATE TRIGGER variant_owner_guard BEFORE UPDATE ON public.product_variants FOR EACH ROW EXECUTE FUNCTION public.p2_parent_identity_guard();
CREATE FUNCTION public.p2_legacy_barcode_sync() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE t uuid;
BEGIN
 IF TG_OP='UPDATE' AND OLD.barcode IS NOT NULL AND NEW.barcode IS DISTINCT FROM OLD.barcode THEN
  IF NEW.barcode IS NOT NULL OR EXISTS(SELECT 1 FROM public.product_barcodes WHERE variant_id=OLD.id AND barcode=OLD.barcode) THEN RAISE EXCEPTION 'Delete the old barcode record before changing the legacy code' USING ERRCODE='23514'; END IF;
 END IF;
 IF NEW.barcode IS NOT NULL THEN
  SELECT tenant_id INTO STRICT t FROM public.products WHERE id=NEW.product_id;
  IF NOT EXISTS(SELECT 1 FROM public.product_barcodes WHERE tenant_id=t AND barcode=NEW.barcode AND variant_id=NEW.id AND barcode_type='variant') THEN
   INSERT INTO public.product_barcodes(tenant_id,product_id,variant_id,barcode,barcode_type,barcode_source,is_primary)
    VALUES(t,NEW.product_id,NEW.id,NEW.barcode,'variant','legacy',NOT EXISTS(SELECT 1 FROM public.product_barcodes WHERE variant_id=NEW.id AND is_primary));
  END IF;
 END IF;
 RETURN NEW;
END $$;
-- AFTER INSERT is necessary for the composite foreign key to see the variant.
CREATE TRIGGER legacy_barcode_sync AFTER INSERT OR UPDATE OF barcode ON public.product_variants FOR EACH ROW EXECUTE FUNCTION public.p2_legacy_barcode_sync();
CREATE FUNCTION public.p2_deleted_barcode_sync() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
 UPDATE public.product_variants SET barcode=NULL WHERE id=OLD.variant_id AND barcode=OLD.barcode;
 RETURN OLD;
END $$;
CREATE TRIGGER deleted_barcode_sync AFTER DELETE ON public.product_barcodes FOR EACH ROW EXECUTE FUNCTION public.p2_deleted_barcode_sync();

CREATE FUNCTION public.p2_tenant_access(t uuid, writing boolean DEFAULT false) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT EXISTS(SELECT 1 FROM public.current_staff() u WHERE u.id IS NOT NULL AND u.tenant_id=t AND (NOT writing OR u.role IN ('owner','manager')))
$$;
CREATE FUNCTION public.p2_product_access(p uuid, writing boolean DEFAULT false) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT EXISTS(SELECT 1 FROM public.products x WHERE x.id=p AND public.p2_tenant_access(x.tenant_id,writing))
$$;
CREATE FUNCTION public.p2_inventory_access(s uuid,v uuid,writing boolean DEFAULT false) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT EXISTS(SELECT 1 FROM public.stores st JOIN public.product_variants pv ON pv.id=v JOIN public.products p ON p.id=pv.product_id CROSS JOIN public.current_staff() u WHERE st.id=s AND st.tenant_id=p.tenant_id AND u.id IS NOT NULL AND u.tenant_id=st.tenant_id AND (NOT writing OR u.role='owner' OR (u.role='manager' AND u.store_id=s)))
$$;
-- Enforce store/variant consistency even when a SECURITY DEFINER engine writes.
CREATE FUNCTION public.p2_inventory_tenant_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.stores s JOIN public.product_variants v ON v.id=NEW.variant_id JOIN public.products p ON p.id=v.product_id WHERE s.id=NEW.store_id AND s.tenant_id=p.tenant_id) THEN RAISE EXCEPTION 'Inventory tenant mismatch' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER inventory_tenant_guard BEFORE INSERT OR UPDATE OF store_id,variant_id ON public.inventory FOR EACH ROW EXECUTE FUNCTION public.p2_inventory_tenant_guard();
DO $$ DECLARE r record; t text; pred text; BEGIN
 FOR r IN SELECT tablename,policyname FROM pg_policies WHERE schemaname='public' AND tablename IN ('products','product_variants','inventory','product_barcodes') LOOP EXECUTE format('DROP POLICY %I ON public.%I',r.policyname,r.tablename); END LOOP;
 FOREACH t IN ARRAY ARRAY['products','product_variants','inventory','product_barcodes'] LOOP
  EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC, anon, authenticated',t);
  EXECUTE format('GRANT SELECT,INSERT,UPDATE,DELETE ON public.%I TO authenticated',t);
  pred:=CASE t WHEN 'products' THEN 'public.p2_tenant_access(tenant_id,%s)' WHEN 'product_barcodes' THEN 'public.p2_tenant_access(tenant_id,%s)' WHEN 'product_variants' THEN 'public.p2_product_access(product_id,%s)' ELSE 'public.p2_inventory_access(store_id,variant_id,%s)' END;
  EXECUTE format('CREATE POLICY tenant_read ON public.%I FOR SELECT TO authenticated USING (%s)',t,format(pred,'false'));
  EXECUTE format('CREATE POLICY tenant_insert ON public.%I FOR INSERT TO authenticated WITH CHECK (%s)',t,format(pred,'true'));
  EXECUTE format('CREATE POLICY tenant_update ON public.%I FOR UPDATE TO authenticated USING (%s) WITH CHECK (%s)',t,format(pred,'true'),format(pred,'true'));
  EXECUTE format('CREATE POLICY tenant_delete ON public.%I FOR DELETE TO authenticated USING (%s)',t,format(pred,'true'));
 END LOOP;
END $$;

CREATE OR REPLACE FUNCTION public.engine_generate_barcodes(p_store uuid,p_tenant uuid,p_count integer) RETURNS text[] LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE result text[]:='{}'; candidate text; attempts integer:=0; added integer;
BEGIN
 PERFORM public.engine_staff(p_store,p_tenant);
 IF p_count IS NULL OR p_count<1 OR p_count>500 THEN RAISE EXCEPTION 'Invalid barcode count'; END IF;
 WHILE cardinality(result)<p_count LOOP
  attempts:=attempts+1;
  IF attempts>p_count+10000 THEN RAISE EXCEPTION 'Barcode allocation retry limit'; END IF;
  candidate:=nextval('public.engine_barcode_numbers')::text;
  IF EXISTS(SELECT 1 FROM public.product_barcodes WHERE tenant_id=p_tenant AND barcode=candidate) OR EXISTS(SELECT 1 FROM public.product_variants v JOIN public.products p ON p.id=v.product_id WHERE p.tenant_id=p_tenant AND v.barcode=candidate) THEN CONTINUE; END IF;
  INSERT INTO barcode_internal.claims(tenant_id,barcode) VALUES(p_tenant,candidate) ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS added=ROW_COUNT;
  IF added=1 THEN result:=array_append(result,candidate); END IF;
 END LOOP;
 RETURN result;
END $$;
-- Create-only atomic RPC. Phase 2 UI will opt into this contract later.
CREATE FUNCTION public.engine_create_product_atomic(p_store uuid,p_tenant uuid,p_product jsonb,p_variants jsonb,p_model_barcodes jsonb DEFAULT '[]') RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE pid uuid; vid uuid; x jsonb; b jsonb; code text; source text; codes jsonb; qty integer; first_code boolean;
BEGIN
 PERFORM public.engine_validate(p_store,p_tenant,ARRAY['owner','manager']);
 IF jsonb_typeof(p_product) IS DISTINCT FROM 'object' OR nullif(btrim(p_product->>'name'),'') IS NULL OR (p_product->>'base_price') IS NULL OR (p_product->>'base_price')::integer<0 THEN RAISE EXCEPTION 'Invalid product'; END IF;
 IF jsonb_typeof(p_variants) IS DISTINCT FROM 'array' OR jsonb_array_length(p_variants) NOT BETWEEN 1 AND 500 OR jsonb_typeof(p_model_barcodes) IS DISTINCT FROM 'array' OR jsonb_array_length(p_model_barcodes)>50 THEN RAISE EXCEPTION 'Invalid variant/barcode list'; END IF;
 INSERT INTO public.products(tenant_id,name,base_price,description,category,subcategory,brand,images,image_url,external_video_url,is_active)
 VALUES(p_tenant,btrim(p_product->>'name'),(p_product->>'base_price')::integer,p_product->>'description',p_product->>'category',p_product->>'subcategory',p_product->>'brand',coalesce(ARRAY(SELECT jsonb_array_elements_text(p_product->'images')),'{}'),p_product->>'image_url',p_product->>'external_video_url',true) RETURNING id INTO pid;
 FOR x IN SELECT value FROM jsonb_array_elements(p_variants) LOOP
  qty:=(x->>'quantity')::integer;
  IF qty IS NULL OR qty<0 OR coalesce((x->>'min_price')::integer,0)<0 OR coalesce((x->>'cost_price_avg')::numeric,0)<0 THEN RAISE EXCEPTION 'Invalid variant quantity/price'; END IF;
  INSERT INTO public.product_variants(product_id,color,size,sku,min_price,cost_price_avg) VALUES(pid,x->>'color',x->>'size',x->>'sku',coalesce((x->>'min_price')::integer,0),coalesce((x->>'cost_price_avg')::numeric,0)) RETURNING id INTO vid;
  INSERT INTO public.inventory(store_id,variant_id,quantity) VALUES(p_store,vid,qty);
  codes:=coalesce(x->'barcodes','[]'::jsonb);
  IF jsonb_typeof(codes) IS DISTINCT FROM 'array' OR jsonb_array_length(codes)>50 THEN RAISE EXCEPTION 'Invalid aliases'; END IF;
  IF jsonb_array_length(codes)=0 THEN codes:=jsonb_build_array(jsonb_build_object('barcode',(public.engine_generate_barcodes(p_store,p_tenant,1))[1],'source','generated')); END IF;
  first_code:=true;
  FOR b IN SELECT value FROM jsonb_array_elements(codes) LOOP
   code:=b->>'barcode'; source:=coalesce(b->>'source','manual');
   IF source='legacy' THEN RAISE EXCEPTION 'legacy source is reserved for compatibility backfill'; END IF;
   INSERT INTO public.product_barcodes(tenant_id,product_id,variant_id,barcode,barcode_type,barcode_source,is_primary) VALUES(p_tenant,pid,vid,code,'variant',source,first_code);
   IF first_code THEN UPDATE public.product_variants SET barcode=code WHERE id=vid; first_code:=false; END IF;
  END LOOP;
 END LOOP;
 first_code:=true;
 FOR b IN SELECT value FROM jsonb_array_elements(p_model_barcodes) LOOP
  INSERT INTO public.product_barcodes(tenant_id,product_id,barcode,barcode_type,barcode_source,is_primary) VALUES(p_tenant,pid,b->>'barcode','model',coalesce(b->>'source','manual'),first_code); first_code:=false;
 END LOOP;
 RETURN pid;
END $$;
-- No PUBLIC execute defaults on SECURITY DEFINER helpers / trigger functions.
REVOKE ALL ON FUNCTION public.p2_barcode_guard(),public.p2_parent_identity_guard(),public.p2_legacy_barcode_sync(),public.p2_deleted_barcode_sync(),public.p2_inventory_tenant_guard() FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.p2_tenant_access(uuid,boolean),public.p2_product_access(uuid,boolean),public.p2_inventory_access(uuid,uuid,boolean),public.engine_create_product_atomic(uuid,uuid,jsonb,jsonb,jsonb),public.engine_generate_barcodes(uuid,uuid,integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.p2_tenant_access(uuid,boolean),public.p2_product_access(uuid,boolean),public.p2_inventory_access(uuid,uuid,boolean),public.engine_create_product_atomic(uuid,uuid,jsonb,jsonb,jsonb),public.engine_generate_barcodes(uuid,uuid,integer) TO authenticated;
NOTIFY pgrst,'reload schema';
