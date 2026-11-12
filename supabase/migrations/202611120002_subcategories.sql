-- Smart subcategories.
--
-- The default subcategory list lives in lib/categories.js and ships with the
-- app. Anything the owner types that isn't in that list is stored here, per
-- tenant per main category, so it survives and shows up for every future
-- product on every device.
--
-- House rule for new tables (see 202611100022): RLS on, no direct grants, and
-- all access funnelled through validated SECURITY DEFINER RPCs.

ALTER TABLE public.products ADD COLUMN IF NOT EXISTS subcategory text;

CREATE TABLE IF NOT EXISTS public.custom_subcategories (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  category   text NOT NULL,
  name       text NOT NULL,
  created_by uuid REFERENCES public.users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Case- and whitespace-insensitive: "قميص كلاسيك " and "قميص كلاسيك" collide.
CREATE UNIQUE INDEX IF NOT EXISTS custom_subcategories_unique
  ON public.custom_subcategories (tenant_id, category, lower(btrim(name)));
CREATE INDEX IF NOT EXISTS custom_subcategories_lookup
  ON public.custom_subcategories (tenant_id, category, name);

ALTER TABLE public.custom_subcategories ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.custom_subcategories FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------- read them
CREATE OR REPLACE FUNCTION public.engine_subcategories(p_tenant uuid)
RETURNS TABLE(category text, name text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE u public.users;
BEGIN
  SELECT * INTO u FROM public.current_staff();
  IF u.id IS NULL OR u.tenant_id IS DISTINCT FROM p_tenant THEN
    RAISE EXCEPTION 'غير مصرح بعرض التصنيفات الفرعية';
  END IF;
  RETURN QUERY
    SELECT s.category, s.name
    FROM public.custom_subcategories s
    WHERE s.tenant_id = p_tenant
    ORDER BY s.category, s.name;
END $$;

-- ------------------------------------------------------------------ add one
CREATE OR REPLACE FUNCTION public.engine_add_subcategory(p_tenant uuid, p_category text, p_name text)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE u public.users;
BEGIN
  SELECT * INTO u FROM public.current_staff();
  IF u.id IS NULL OR u.tenant_id IS DISTINCT FROM p_tenant OR u.role NOT IN ('owner','manager') THEN
    RAISE EXCEPTION 'غير مصرح بإضافة تصنيف فرعي';
  END IF;
  IF nullif(btrim(p_category), '') IS NULL OR nullif(btrim(p_name), '') IS NULL THEN
    RAISE EXCEPTION 'التصنيف والاسم مطلوبان';
  END IF;
  BEGIN
    INSERT INTO public.custom_subcategories(tenant_id, category, name, created_by)
    VALUES (p_tenant, btrim(p_category), btrim(p_name), u.id);
  EXCEPTION WHEN unique_violation THEN
    NULL; -- already saved, possibly by another device; not an error
  END;
END $$;

REVOKE ALL ON FUNCTION public.engine_subcategories(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.engine_add_subcategory(uuid,text,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.engine_subcategories(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.engine_add_subcategory(uuid,text,text) TO authenticated;

-- Backfill anything already typed on existing products. Runs after the column
-- above, so it is safe on a fresh database too.
INSERT INTO public.custom_subcategories (tenant_id, category, name)
SELECT DISTINCT p.tenant_id, btrim(p.category), btrim(p.subcategory)
FROM public.products p
WHERE p.subcategory IS NOT NULL AND btrim(p.subcategory) <> ''
  AND p.category IS NOT NULL AND btrim(p.category) <> ''
ON CONFLICT DO NOTHING;
