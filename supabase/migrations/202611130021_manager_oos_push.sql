-- Staff-only Web Push. No reads/writes or schema changes to public.orders.
CREATE EXTENSION IF NOT EXISTS pg_net WITH SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE TABLE public.staff_push_subscriptions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 staff_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
 tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
 store_id uuid NOT NULL REFERENCES public.stores(id) ON DELETE CASCADE,
 endpoint text NOT NULL CHECK(endpoint LIKE 'https://%'),
 p256dh text NOT NULL, auth text NOT NULL,
 updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(endpoint,store_id)
);
CREATE INDEX staff_push_branch_idx ON public.staff_push_subscriptions(store_id,tenant_id);
CREATE TABLE public.oos_push_outbox (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 token text NOT NULL DEFAULT encode(extensions.gen_random_bytes(32),'hex'),
 store_id uuid NOT NULL REFERENCES public.stores(id) ON DELETE CASCADE,
 tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
 variant_id uuid NOT NULL REFERENCES public.product_variants(id) ON DELETE CASCADE,
 store_name text, product_name text, color text, size text,
 created_at timestamptz NOT NULL DEFAULT now(),
 delivered_at timestamptz, locked_until timestamptz,
 attempts integer NOT NULL DEFAULT 0,
 dispatch_attempts integer NOT NULL DEFAULT 0,
 last_dispatched_at timestamptz,
 sent_count integer NOT NULL DEFAULT 0, failed_count integer NOT NULL DEFAULT 0
);
ALTER TABLE public.staff_push_subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.oos_push_outbox ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.staff_push_subscriptions,public.oos_push_outbox FROM PUBLIC,anon,authenticated;
GRANT ALL ON public.staff_push_subscriptions,public.oos_push_outbox TO service_role;

-- Capability token is event-specific, never in URL/logs or available to users.
-- Replay/concurrency guarded by lease; failed sends retry for up to 24h/100 tries.
CREATE OR REPLACE FUNCTION public.claim_oos_push(p_id uuid,p_token text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE result jsonb;
BEGIN
 UPDATE public.oos_push_outbox SET locked_until=now()+interval '2 minutes',attempts=attempts+1
 WHERE id=p_id AND token=p_token AND delivered_at IS NULL AND attempts<100
 AND created_at>now()-interval '24 hours' AND (locked_until IS NULL OR locked_until<now())
 RETURNING to_jsonb(oos_push_outbox)-'token' INTO result;
 RETURN result;
END $$;

CREATE OR REPLACE FUNCTION public.dispatch_pending_oos_push() RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,extensions AS $$
DECLARE e public.oos_push_outbox;
BEGIN
 FOR e IN SELECT * FROM public.oos_push_outbox WHERE delivered_at IS NULL
 AND attempts<100 AND dispatch_attempts<100 AND created_at>now()-interval '24 hours'
 AND (locked_until IS NULL OR locked_until<now())
 AND (last_dispatched_at IS NULL OR last_dispatched_at<now()-interval '1 minute')
 ORDER BY created_at LIMIT 20 FOR UPDATE SKIP LOCKED LOOP
  BEGIN
   PERFORM net.http_post(
    url:='https://vetrina-app-wheat.vercel.app/api/push/oos',
    headers:='{"Content-Type":"application/json"}'::jsonb,
    body:=jsonb_build_object('id',e.id,'token',e.token),timeout_milliseconds:=5000);
   UPDATE public.oos_push_outbox SET last_dispatched_at=now(),dispatch_attempts=dispatch_attempts+1 WHERE id=e.id;
  EXCEPTION WHEN OTHERS THEN
   -- Network dispatch must never roll back a sale or stock write.
   UPDATE public.oos_push_outbox SET dispatch_attempts=dispatch_attempts+1,last_dispatched_at=now() WHERE id=e.id;
  END;
 END LOOP;
END $$;

CREATE OR REPLACE FUNCTION public.enqueue_oos_push() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
BEGIN
 IF OLD.quantity>0 AND NEW.quantity=0 THEN
  INSERT INTO public.oos_push_outbox(store_id,tenant_id,variant_id,store_name,product_name,color,size)
  SELECT NEW.store_id,s.tenant_id,v.id,s.name,p.name,v.color,v.size
  FROM public.stores s JOIN public.product_variants v ON v.id=NEW.variant_id
  JOIN public.products p ON p.id=v.product_id
  WHERE s.id=NEW.store_id AND p.tenant_id=s.tenant_id;
  PERFORM public.dispatch_pending_oos_push();
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER branch_oos_push AFTER UPDATE OF quantity ON public.inventory FOR EACH ROW EXECUTE FUNCTION public.enqueue_oos_push();
REVOKE ALL ON FUNCTION public.claim_oos_push(uuid,text),public.dispatch_pending_oos_push(),public.enqueue_oos_push() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.claim_oos_push(uuid,text),public.dispatch_pending_oos_push() TO service_role;
SELECT cron.schedule('vetrina-oos-push-retry','* * * * *','SELECT public.dispatch_pending_oos_push()');
