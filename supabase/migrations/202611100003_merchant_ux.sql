ALTER TABLE public.purchases ADD COLUMN IF NOT EXISTS description text;

-- Reserve globally distinct 12-digit numeric codes. The existing UNIQUE(barcode)
-- constraint remains the final guard against externally supplied duplicates.
CREATE SEQUENCE IF NOT EXISTS public.engine_barcode_numbers
  AS bigint MINVALUE 100000000000 MAXVALUE 999999999999 START 100000000000 NO CYCLE;
REVOKE ALL ON SEQUENCE public.engine_barcode_numbers FROM PUBLIC, anon, authenticated;
CREATE OR REPLACE FUNCTION public.engine_generate_barcodes(p_store uuid,p_tenant uuid,p_count integer)
RETURNS text[] LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE result text[] := ARRAY[]::text[]; candidate text;
BEGIN
  PERFORM public.engine_staff(p_store,p_tenant);
  IF p_count IS NULL OR p_count<1 OR p_count>500 THEN RAISE EXCEPTION 'عدد الباركود المطلوب غير صالح'; END IF;
  WHILE cardinality(result)<p_count LOOP
    candidate := nextval('public.engine_barcode_numbers')::text;
    IF NOT EXISTS (SELECT 1 FROM public.product_variants WHERE barcode=candidate) THEN
      result := array_append(result,candidate);
    END IF;
  END LOOP;
  RETURN result;
END $$;
REVOKE ALL ON FUNCTION public.engine_generate_barcodes(uuid,uuid,integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.engine_generate_barcodes(uuid,uuid,integer) TO authenticated;

-- Wrap the existing receipt transaction so description + receipt remain atomic,
-- retain compatibility for Phase 2 clients, and include text in retry validation.
CREATE OR REPLACE FUNCTION public.engine_receive_purchase_with_description(
  p_store uuid,p_tenant uuid,p_supplier uuid,p_items jsonb,p_request uuid,p_description text)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE result uuid; previous public.purchases; text_value text := nullif(trim(p_description),'');
BEGIN
  PERFORM public.engine_staff(p_store,p_tenant);
  IF length(text_value)>4000 THEN RAISE EXCEPTION 'وصف المنتج طويل جداً (4000 حرف كحد أقصى)'; END IF;
  IF p_request IS NULL THEN RAISE EXCEPTION 'معرّف الطلب مطلوب'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(p_request::text,0));
  SELECT * INTO previous FROM public.purchases WHERE request_id=p_request;
  IF FOUND AND previous.description IS DISTINCT FROM text_value THEN RAISE EXCEPTION 'طلب شراء مكرر بوصف مختلف'; END IF;
  result := public.engine_receive_purchase(p_store,p_tenant,p_supplier,p_items,p_request);
  UPDATE public.purchases SET description=text_value WHERE id=result;
  RETURN result;
END $$;
REVOKE ALL ON FUNCTION public.engine_receive_purchase_with_description(uuid,uuid,uuid,jsonb,uuid,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.engine_receive_purchase_with_description(uuid,uuid,uuid,jsonb,uuid,text) TO authenticated;
