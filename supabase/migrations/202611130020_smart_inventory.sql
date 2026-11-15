-- v3.2: Master is tenant-wide; inventory remains exclusively Branch.
-- No writes or schema changes to public.orders.
CREATE TABLE public.inventory_master (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id uuid NOT NULL REFERENCES public.tenants(id),
 variant_id uuid NOT NULL REFERENCES public.product_variants(id) ON DELETE CASCADE,
 quantity integer NOT NULL DEFAULT 0 CHECK(quantity >= 0),
 updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(tenant_id,variant_id)
);
ALTER TABLE public.inventory_master ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.inventory_master FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.inventory_master TO service_role;

CREATE OR REPLACE FUNCTION public.engine_master_stock(p_store uuid, p_variant uuid DEFAULT NULL, p_quantity integer DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE t uuid; u public.users; result jsonb;
BEGIN
 SELECT tenant_id INTO t FROM public.stores WHERE id=p_store;
 PERFORM public.engine_staff(p_store,t);
 SELECT * INTO u FROM public.current_staff();
 IF p_quantity IS NOT NULL THEN
  IF u.role <> 'owner' OR p_quantity < 0 OR p_variant IS NULL THEN RAISE EXCEPTION 'تعديل المستودع للمالك فقط وبكمية صحيحة'; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.product_variants v JOIN public.products p ON p.id=v.product_id WHERE v.id=p_variant AND p.tenant_id=t) THEN RAISE EXCEPTION 'منتج غير صالح'; END IF;
  INSERT INTO public.inventory_master(tenant_id,variant_id,quantity) VALUES(t,p_variant,p_quantity)
   ON CONFLICT(tenant_id,variant_id) DO UPDATE SET quantity=excluded.quantity,updated_at=now();
 END IF;
 SELECT coalesce(jsonb_agg(jsonb_build_object('id',m.id,'variant_id',v.id,'quantity',m.quantity,'name',p.name,'color',v.color,'size',v.size)), '[]'::jsonb) INTO result
 FROM public.inventory_master m JOIN public.product_variants v ON v.id=m.variant_id JOIN public.products p ON p.id=v.product_id WHERE m.tenant_id=t;
 RETURN result;
END $$;

CREATE OR REPLACE FUNCTION public.engine_oos(p_store uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE t uuid; result jsonb;
BEGIN
 SELECT tenant_id INTO t FROM public.stores WHERE id=p_store;
 PERFORM public.engine_staff(p_store,t);
 SELECT coalesce(jsonb_agg(jsonb_build_object('id',i.id,'variant_id',v.id,'name',p.name,'image',coalesce(p.images[1],p.image_url),'color',v.color,'size',v.size,
 'masterQuantity',coalesce(m.quantity,0),'otherBranchName',coalesce(b.name,''))), '[]'::jsonb) INTO result
 FROM public.inventory i JOIN public.product_variants v ON v.id=i.variant_id JOIN public.products p ON p.id=v.product_id
 LEFT JOIN public.inventory_master m ON m.variant_id=v.id AND m.tenant_id=t
 LEFT JOIN LATERAL(SELECT s.name FROM public.inventory j JOIN public.stores s ON s.id=j.store_id WHERE j.variant_id=v.id AND j.quantity>0 AND j.store_id<>p_store AND s.tenant_id=t ORDER BY s.id LIMIT 1) b ON true
 WHERE i.store_id=p_store AND i.quantity=0 AND p.tenant_id=t;
 RETURN result;
END $$;

CREATE OR REPLACE FUNCTION public.engine_replenish_master(p_store uuid,p_variant uuid) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE t uuid; q integer;
BEGIN
 SELECT tenant_id INTO t FROM public.stores WHERE id=p_store;
 PERFORM public.engine_staff(p_store,t);
 SELECT quantity INTO q FROM public.inventory_master WHERE tenant_id=t AND variant_id=p_variant FOR UPDATE;
 IF coalesce(q,0)<=0 THEN RAISE EXCEPTION 'لا توجد كمية متاحة في المستودع'; END IF;
 UPDATE public.inventory_master SET quantity=0,updated_at=now() WHERE tenant_id=t AND variant_id=p_variant;
 INSERT INTO public.inventory(store_id,variant_id,quantity) VALUES(p_store,p_variant,q)
 ON CONFLICT(store_id,variant_id) DO UPDATE SET quantity=inventory.quantity+excluded.quantity,updated_at=now();
 RETURN q;
END $$;

CREATE OR REPLACE FUNCTION public.notify_branch_oos() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v public.product_variants; p public.products;
BEGIN
 IF NEW.quantity=0 AND OLD.quantity>0 THEN
  SELECT * INTO v FROM public.product_variants WHERE id=NEW.variant_id;
  SELECT * INTO p FROM public.products WHERE id=v.product_id;
  INSERT INTO public.alerts(store_id,type,message) VALUES(NEW.store_id,'out_of_stock',p.name || ' · ' || coalesce(v.color,'') || ' / ' || coalesce(v.size,''));
  PERFORM pg_notify('branch_oos',json_build_object('store_id',NEW.store_id,'variant_id',NEW.variant_id)::text);
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER branch_oos AFTER UPDATE OF quantity ON public.inventory FOR EACH ROW EXECUTE FUNCTION public.notify_branch_oos();
REVOKE ALL ON FUNCTION public.engine_master_stock(uuid,uuid,integer),public.engine_oos(uuid),public.engine_replenish_master(uuid,uuid),public.notify_branch_oos() FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.engine_master_stock(uuid,uuid,integer),public.engine_oos(uuid),public.engine_replenish_master(uuid,uuid) TO authenticated;
-- Publish only Branch inventory changes; RLS still filters each subscriber.
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_publication WHERE pubname='supabase_realtime')
 AND NOT EXISTS(SELECT 1 FROM pg_publication_tables WHERE pubname='supabase_realtime' AND schemaname='public' AND tablename='inventory') THEN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.inventory;
 END IF;
END $$;
