-- Phase 3: additive, no historical updates, no orders/reservation/barcode DDL.
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '60s';
CREATE FUNCTION public.p3_normalize_colors(input text[]) RETURNS text[]
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,public AS $$
DECLARE result text[];
BEGIN
 IF input IS NULL OR array_ndims(input) IS DISTINCT FROM 1 OR cardinality(input) NOT BETWEEN 1 AND 6 THEN RAISE EXCEPTION 'Expected 1 to 6 colors'; END IF;
 IF EXISTS(SELECT 1 FROM unnest(input) c WHERE c IS NULL OR length(btrim(c)) NOT BETWEEN 1 AND 40 OR c ~ '[[:cntrl:]]') THEN RAISE EXCEPTION 'Invalid color component'; END IF;
 SELECT array_agg(c ORDER BY c COLLATE "C") INTO result FROM (SELECT btrim(c) c FROM unnest(input) c) normalized;
 IF (SELECT count(DISTINCT c COLLATE "C") FROM unnest(result) c) <> cardinality(result) THEN RAISE EXCEPTION 'Duplicate color component'; END IF;
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION public.p3_normalize_colors(text[]) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.p3_normalize_colors(text[]) TO authenticated;
ALTER TABLE public.product_variants ADD COLUMN color_components text[];
ALTER TABLE public.product_variants ADD CONSTRAINT variants_color_components_p3 CHECK (
 color_components IS NULL OR (color_components = public.p3_normalize_colors(color_components) AND color = array_to_string(color_components,' / ') AND color IS NOT NULL)
);
COMMENT ON COLUMN public.product_variants.color_components IS 'NULL = legacy unstructured; otherwise canonical color set. Never parse legacy color labels.';
CREATE OR REPLACE FUNCTION public.engine_create_product_atomic(p_store uuid,p_tenant uuid,p_product jsonb,p_variants jsonb,p_model_barcodes jsonb DEFAULT '[]') RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE pid uuid; vid uuid; x jsonb; b jsonb; code text; source text; codes jsonb; qty integer; first_code boolean; parts text[]; display_color text; identity_key text; seen_keys text[] := ARRAY[]::text[]; seen_labels text[] := ARRAY[]::text[]; label_key text;
BEGIN
 PERFORM public.engine_validate(p_store,p_tenant,ARRAY['owner','manager']);
 IF jsonb_typeof(p_product) IS DISTINCT FROM 'object' OR nullif(btrim(p_product->>'name'),'') IS NULL OR (p_product->>'base_price') IS NULL OR (p_product->>'base_price')::integer<0 THEN RAISE EXCEPTION 'Invalid product'; END IF;
 IF jsonb_typeof(p_variants) IS DISTINCT FROM 'array' OR jsonb_array_length(p_variants) NOT BETWEEN 1 AND 500 OR jsonb_typeof(p_model_barcodes) IS DISTINCT FROM 'array' OR jsonb_array_length(p_model_barcodes)>50 THEN RAISE EXCEPTION 'Invalid variant/barcode list'; END IF;
 INSERT INTO public.products(tenant_id,name,base_price,description,category,subcategory,brand,images,image_url,external_video_url,is_active)
 VALUES(p_tenant,btrim(p_product->>'name'),(p_product->>'base_price')::integer,p_product->>'description',p_product->>'category',p_product->>'subcategory',p_product->>'brand',coalesce(ARRAY(SELECT jsonb_array_elements_text(p_product->'images')),'{}'),p_product->>'image_url',p_product->>'external_video_url',true) RETURNING id INTO pid;
 FOR x IN SELECT value FROM jsonb_array_elements(p_variants) LOOP
  qty:=(x->>'quantity')::integer;
  IF qty IS NULL OR qty<0 OR coalesce((x->>'min_price')::integer,0)<0 OR coalesce((x->>'cost_price_avg')::numeric,0)<0 THEN RAISE EXCEPTION 'Invalid variant quantity/price'; END IF;
  parts := NULL;
  display_color := x->>'color';
  IF x ? 'color_components' THEN
   IF jsonb_typeof(x->'color_components') IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'Invalid color components'; END IF;
   IF EXISTS(SELECT 1 FROM jsonb_array_elements(x->'color_components') e WHERE jsonb_typeof(e) <> 'string') THEN RAISE EXCEPTION 'Color components must be strings'; END IF;
   parts := public.p3_normalize_colors(ARRAY(SELECT jsonb_array_elements_text(x->'color_components')));
   display_color := array_to_string(parts,' / ');
  END IF;
  identity_key := jsonb_build_array(coalesce(to_jsonb(parts),to_jsonb(display_color)),x->>'size')::text;
  label_key := jsonb_build_array(display_color,x->>'size')::text;
  IF label_key = ANY(seen_labels) OR identity_key = ANY(seen_keys) THEN RAISE EXCEPTION 'Duplicate color/size combination'; END IF;
  seen_keys := array_append(seen_keys,identity_key);
  seen_labels := array_append(seen_labels,label_key);
  INSERT INTO public.product_variants(product_id,color,color_components,size,sku,min_price,cost_price_avg) VALUES(pid,display_color,parts,x->>'size',x->>'sku',coalesce((x->>'min_price')::integer,0),coalesce((x->>'cost_price_avg')::numeric,0)) RETURNING id INTO vid;
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
