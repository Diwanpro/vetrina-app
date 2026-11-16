-- Patch the deployed engine without replacing unrelated payment/customer logic.
DO $$
DECLARE d text; old text; new text;
BEGIN
 d := pg_get_functiondef('public.engine_sync_sale(uuid,uuid,text,jsonb,text,timestamptz,jsonb)'::regprocedure);
 old := 'SELECT quantity INTO stock FROM public.inventory WHERE variant_id=item.variant_id AND store_id=p_store FOR UPDATE;';
 new := 'SELECT quantity - coalesce(reserved_qty,0) INTO stock FROM public.inventory WHERE variant_id=item.variant_id AND store_id=p_store FOR UPDATE;';
 IF position(new in d)=0 THEN
  IF position(old in d)=0 THEN RAISE EXCEPTION 'Unexpected engine_sync_sale definition'; END IF;
  EXECUTE replace(d,old,new);
 END IF;
 d := pg_get_functiondef('public.engine_transfer(uuid,uuid,uuid,uuid,integer,uuid)'::regprocedure);
 old := 'SELECT quantity INTO stock FROM public.inventory WHERE store_id=p_from AND variant_id=p_variant;';
 new := 'SELECT quantity - coalesce(reserved_qty,0) INTO stock FROM public.inventory WHERE store_id=p_from AND variant_id=p_variant FOR UPDATE;';
 IF position(new in d)=0 THEN
  IF position(old in d)=0 THEN RAISE EXCEPTION 'Unexpected engine_transfer definition'; END IF;
  EXECUTE replace(d,old,new);
 END IF;
 d := pg_get_functiondef('public.update_order_status(uuid,text,text)'::regprocedure);
 old := 'IF u.role NOT IN (''owner'', ''manager'') AND u.store_id IS DISTINCT FROM o.store_id THEN';
 new := 'IF u.role NOT IN (''owner'', ''manager'') OR (u.role = ''manager'' AND u.store_id IS DISTINCT FROM o.store_id) THEN';
 IF position(new in d)=0 THEN
  IF position(old in d)=0 THEN RAISE EXCEPTION 'Unexpected update_order_status authorization'; END IF;
  d := replace(d,old,new);
  -- Lock all affected rows before reservation release and sale consumption.
  old := 'was_reserved := old_status IN (''confirmed'', ''preparing'');';
  IF position(old in d)=0 THEN RAISE EXCEPTION 'Unexpected reservation lifecycle'; END IF;
  d := replace(d,old,old || E'\n  PERFORM i.id FROM public.inventory i WHERE i.store_id=o.store_id AND i.variant_id IN (SELECT variant_id FROM public.order_items WHERE order_id=o.id) ORDER BY i.variant_id FOR UPDATE;');
  EXECUTE d;
 END IF;
END $$;
-- Fail rather than silently repair inconsistent existing balances.
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.inventory'::regclass AND conname='inventory_reservation_bounds') THEN
  ALTER TABLE public.inventory ADD CONSTRAINT inventory_reservation_bounds CHECK (quantity >= 0 AND coalesce(reserved_qty,0) >= 0 AND coalesce(reserved_qty,0) <= quantity);
 END IF;
END $$;
