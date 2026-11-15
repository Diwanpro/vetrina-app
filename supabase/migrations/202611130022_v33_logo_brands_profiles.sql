-- v3.3. Never modifies public.orders.
INSERT INTO storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
VALUES('store-logos','store-logos',true,2097152,ARRAY['image/jpeg','image/png','image/webp'])
ON CONFLICT(id) DO UPDATE SET public=true,file_size_limit=excluded.file_size_limit,allowed_mime_types=excluded.allowed_mime_types;
CREATE OR REPLACE FUNCTION public.engine_logo_access(p_path text) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public AS $$
DECLARE u public.users; parts text[]:=string_to_array(p_path,'/');
BEGIN
 SELECT * INTO u FROM public.current_staff();
 RETURN u.id IS NOT NULL AND u.role IN ('owner','manager') AND array_length(parts,1)=3
 AND parts[1]=u.tenant_id::text AND EXISTS(SELECT 1 FROM public.stores s WHERE s.id::text=parts[2] AND s.tenant_id=u.tenant_id AND (u.role='owner' OR s.id=u.store_id));
END $$;
REVOKE ALL ON FUNCTION public.engine_logo_access(text) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.engine_logo_access(text) TO authenticated;
CREATE POLICY store_logos_insert ON storage.objects FOR INSERT TO authenticated WITH CHECK(bucket_id='store-logos' AND public.engine_logo_access(name));
CREATE POLICY store_logos_read ON storage.objects FOR SELECT TO authenticated USING(bucket_id='store-logos' AND public.engine_logo_access(name));
CREATE POLICY store_logos_update ON storage.objects FOR UPDATE TO authenticated USING(bucket_id='store-logos' AND public.engine_logo_access(name)) WITH CHECK(bucket_id='store-logos' AND public.engine_logo_access(name));
CREATE POLICY store_logos_delete ON storage.objects FOR DELETE TO authenticated USING(bucket_id='store-logos' AND public.engine_logo_access(name));
ALTER TABLE public.products ADD COLUMN IF NOT EXISTS brand text CHECK(char_length(brand)<=80);
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_publication WHERE pubname='supabase_realtime') AND NOT EXISTS(SELECT 1 FROM pg_publication_tables WHERE pubname='supabase_realtime' AND schemaname='public' AND tablename='stores') THEN
 ALTER PUBLICATION supabase_realtime ADD TABLE public.stores;
 END IF;
END $$;
CREATE OR REPLACE FUNCTION public.engine_set_branch_specialty(p_store uuid,p_store_type text,p_theme_key text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE t uuid;
BEGIN
 SELECT tenant_id INTO t FROM public.stores WHERE id=p_store;
 PERFORM public.engine_staff(p_store,t);
 IF p_store_type IS NULL OR p_theme_key IS NULL OR p_store_type NOT IN ('mens','womens','mixed') OR p_theme_key NOT IN ('classic','feminine') THEN RAISE EXCEPTION 'تخصص أو قالب غير صالح'; END IF;
 UPDATE public.stores SET store_type=p_store_type,theme_key=p_theme_key WHERE id=p_store;
END $$;
REVOKE ALL ON FUNCTION public.engine_set_branch_specialty(uuid,text,text) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.engine_set_branch_specialty(uuid,text,text) TO authenticated;

-- Audit finding: product form uses the existing products bucket, which lacked
-- authenticated object policies. Its namespace is tenant/file (not logo paths).
CREATE OR REPLACE FUNCTION public.engine_product_upload_access(p_path text) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public AS $$
DECLARE u public.users; parts text[]:=string_to_array(p_path,'/');
BEGIN
 SELECT * INTO u FROM public.current_staff();
 RETURN u.id IS NOT NULL AND u.role IN ('owner','manager') AND array_length(parts,1)=2 AND parts[1]=u.tenant_id::text;
END $$;
REVOKE ALL ON FUNCTION public.engine_product_upload_access(text) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.engine_product_upload_access(text) TO authenticated;
CREATE POLICY products_bucket_write ON storage.objects FOR ALL TO authenticated USING(bucket_id='products' AND public.engine_product_upload_access(name)) WITH CHECK(bucket_id='products' AND public.engine_product_upload_access(name));
