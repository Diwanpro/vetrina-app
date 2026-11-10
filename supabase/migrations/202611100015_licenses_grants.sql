-- Defence in depth for the license registry.
--
-- `public.licenses` already has RLS enabled with no policies, which is what
-- actually blocks PostgREST reads today. The pre-existing table/column grants to
-- anon/authenticated were never revoked, though, so a future policy added for
-- some other reason would silently expose every key. Removal is safe: all
-- access goes through SECURITY DEFINER functions owned by postgres.

REVOKE ALL ON public.licenses FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.license_redemptions FROM PUBLIC, anon, authenticated;
