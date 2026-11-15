-- P1 / P2: shipping integrations (dual strategy: direct API + bulk CSV export).
--
-- Design decisions (approved blueprint):
--   * Merchant API keys are secrets, so they must NOT live on public.stores:
--     the generic RLS policy from 202611120011 lets every authenticated staff
--     member read a store row. shipping_connections is readable by nobody but
--     the service role and SECURITY DEFINER RPCs that return masked fields.
--   * public.orders is NEVER altered here. The new tables only hold a foreign
--     key TO orders (order_id); no ALTER/UPDATE/INSERT/DELETE touches orders.
--     Order status stays governed by update_order_status + order_status_history.
--   * Naming follows the app: tenant_id / store_id / stores (never branches).
--   * provider_code is deliberately NOT a CHECK enum: adding a courier later is
--     one adapter file + one registry entry, with no new migration.
--   * Idempotent: CREATE TABLE IF NOT EXISTS, guarded constraints, guarded
--     policies, IF NOT EXISTS indexes, CREATE OR REPLACE FUNCTION.
-- Apply after 202611120014.

-- ------------------------------------------------------------- connections
CREATE TABLE IF NOT EXISTS public.shipping_connections (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  store_id                 uuid NOT NULL REFERENCES public.stores(id) ON DELETE CASCADE,
  provider_code            text NOT NULL,
  environment              text NOT NULL DEFAULT 'sandbox',
  mode                     text NOT NULL DEFAULT 'api',
  enabled                  boolean NOT NULL DEFAULT true,
  -- Serialised AES-256-GCM envelope {v,iv,tag,data}. NULL for bulk-only rows.
  credentials_ciphertext   text,
  -- Never a secret: "•••• 4AF2" computed at save time.
  credentials_hint         text NOT NULL DEFAULT '',
  origin_wilaya_code       text,
  defaults                 jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_test_at             timestamptz,
  last_test_ok             boolean,
  last_test_mode           text,
  last_test_message        text,
  created_by               uuid,
  updated_by               uuid,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now()
);

DO $shipping_connections$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'shipping_connections_provider_format') THEN
    ALTER TABLE public.shipping_connections ADD CONSTRAINT shipping_connections_provider_format
      CHECK (provider_code ~ '^[a-z0-9_]{2,40}$');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'shipping_connections_environment_check') THEN
    ALTER TABLE public.shipping_connections ADD CONSTRAINT shipping_connections_environment_check
      CHECK (environment IN ('sandbox','production'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'shipping_connections_mode_check') THEN
    ALTER TABLE public.shipping_connections ADD CONSTRAINT shipping_connections_mode_check
      CHECK (mode IN ('api','bulk','both'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'shipping_connections_credentials_check') THEN
    -- A disabled connection may have had its secret wiped; re-enabling it
    -- without fresh keys is blocked by the gateway, not by this constraint.
    ALTER TABLE public.shipping_connections ADD CONSTRAINT shipping_connections_credentials_check
      CHECK (mode = 'bulk' OR enabled = false OR (credentials_ciphertext IS NOT NULL AND length(credentials_ciphertext) > 20));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'shipping_connections_origin_check') THEN
    ALTER TABLE public.shipping_connections ADD CONSTRAINT shipping_connections_origin_check
      CHECK (origin_wilaya_code IS NULL OR (origin_wilaya_code ~ '^[0-9]{2}$' AND origin_wilaya_code::integer BETWEEN 1 AND 58));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'shipping_connections_defaults_check') THEN
    ALTER TABLE public.shipping_connections ADD CONSTRAINT shipping_connections_defaults_check
      CHECK (jsonb_typeof(defaults) = 'object');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'shipping_connections_hint_check') THEN
    ALTER TABLE public.shipping_connections ADD CONSTRAINT shipping_connections_hint_check
      CHECK (length(credentials_hint) <= 40);
  END IF;
END
$shipping_connections$;

CREATE UNIQUE INDEX IF NOT EXISTS shipping_connections_scope
  ON public.shipping_connections (store_id, provider_code, environment);
CREATE INDEX IF NOT EXISTS shipping_connections_tenant
  ON public.shipping_connections (tenant_id, store_id);

-- ---------------------------------------------------------------- shipments
-- One row per order per courier. Bulk exports also create a row (mode='bulk',
-- status='exported') so the orders screen can show "already exported" and the
-- merchant cannot upload the same order twice.
CREATE TABLE IF NOT EXISTS public.shipments (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  store_id            uuid NOT NULL REFERENCES public.stores(id) ON DELETE CASCADE,
  order_id            uuid NOT NULL REFERENCES public.orders(id) ON DELETE CASCADE,
  provider_code       text NOT NULL,
  environment         text NOT NULL DEFAULT 'sandbox',
  mode                text NOT NULL DEFAULT 'api',
  external_id         text,
  tracking_number     text,
  status              text NOT NULL DEFAULT 'created',
  raw_status          text,
  label_url           text,
  -- Money the courier collects. orders.total already includes delivery_fee;
  -- the fee is never shop revenue (see 202611120007_delivery_rates.sql).
  cod_amount          integer NOT NULL DEFAULT 0,
  delivery_fee        integer NOT NULL DEFAULT 0,
  request_snapshot    jsonb NOT NULL DEFAULT '{}'::jsonb,
  response_snapshot   jsonb,
  idempotency_key     text NOT NULL,
  last_error          text,
  last_synced_at      timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

DO $shipments$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'shipments_status_check') THEN
    ALTER TABLE public.shipments ADD CONSTRAINT shipments_status_check
      CHECK (status IN ('created','in_transit','delivered','returned','cancelled','exported','failed'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'shipments_mode_check') THEN
    ALTER TABLE public.shipments ADD CONSTRAINT shipments_mode_check
      CHECK (mode IN ('api','bulk'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'shipments_environment_check') THEN
    ALTER TABLE public.shipments ADD CONSTRAINT shipments_environment_check
      CHECK (environment IN ('sandbox','production'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'shipments_amounts_check') THEN
    ALTER TABLE public.shipments ADD CONSTRAINT shipments_amounts_check
      CHECK (cod_amount >= 0 AND delivery_fee >= 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'shipments_request_check') THEN
    ALTER TABLE public.shipments ADD CONSTRAINT shipments_request_check
      CHECK (jsonb_typeof(request_snapshot) = 'object');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'shipments_provider_format') THEN
    ALTER TABLE public.shipments ADD CONSTRAINT shipments_provider_format
      CHECK (provider_code ~ '^[a-z0-9_]{2,40}$');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'shipments_idempotency_check') THEN
    ALTER TABLE public.shipments ADD CONSTRAINT shipments_idempotency_check
      CHECK (length(idempotency_key) >= 8);
  END IF;
END
$shipments$;

CREATE UNIQUE INDEX IF NOT EXISTS shipments_active_per_order
  ON public.shipments (order_id, provider_code)
  WHERE status NOT IN ('cancelled','failed');
CREATE UNIQUE INDEX IF NOT EXISTS shipments_idempotency
  ON public.shipments (idempotency_key);
CREATE INDEX IF NOT EXISTS shipments_store_created
  ON public.shipments (store_id, created_at DESC);
CREATE INDEX IF NOT EXISTS shipments_tracking
  ON public.shipments (tracking_number) WHERE tracking_number IS NOT NULL;

-- --------------------------------------------------------- shipment events
-- Webhooks and pullStatuses write here. event_key makes replays idempotent.
CREATE TABLE IF NOT EXISTS public.shipment_events (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  shipment_id       uuid NOT NULL REFERENCES public.shipments(id) ON DELETE CASCADE,
  provider_code     text NOT NULL,
  event_key         text NOT NULL,
  raw_status        text,
  canonical_status  text NOT NULL,
  occurred_at       timestamptz NOT NULL DEFAULT now(),
  payload           jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at        timestamptz NOT NULL DEFAULT now()
);

DO $shipment_events$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'shipment_events_payload_check') THEN
    ALTER TABLE public.shipment_events ADD CONSTRAINT shipment_events_payload_check
      CHECK (jsonb_typeof(payload) = 'object');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'shipment_events_status_check') THEN
    ALTER TABLE public.shipment_events ADD CONSTRAINT shipment_events_status_check
      CHECK (canonical_status IN ('created','in_transit','delivered','returned','cancelled','unknown'));
  END IF;
END
$shipment_events$;

CREATE UNIQUE INDEX IF NOT EXISTS shipment_events_key
  ON public.shipment_events (provider_code, event_key);
CREATE INDEX IF NOT EXISTS shipment_events_shipment
  ON public.shipment_events (shipment_id, occurred_at DESC);

-- ------------------------------------------------------------ bulk exports
CREATE TABLE IF NOT EXISTS public.shipping_export_batches (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  store_id          uuid NOT NULL REFERENCES public.stores(id) ON DELETE CASCADE,
  provider_code     text NOT NULL,
  template_version  text NOT NULL DEFAULT 'v1',
  filters           jsonb NOT NULL DEFAULT '{}'::jsonb,
  row_count         integer NOT NULL DEFAULT 0,
  file_hash         text,
  exported_by       uuid,
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.shipping_export_items (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  batch_id     uuid NOT NULL REFERENCES public.shipping_export_batches(id) ON DELETE CASCADE,
  order_id     uuid NOT NULL REFERENCES public.orders(id) ON DELETE CASCADE,
  shipment_id  uuid REFERENCES public.shipments(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);

DO $shipping_exports$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'shipping_export_batches_count_check') THEN
    ALTER TABLE public.shipping_export_batches ADD CONSTRAINT shipping_export_batches_count_check
      CHECK (row_count >= 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'shipping_export_batches_filters_check') THEN
    ALTER TABLE public.shipping_export_batches ADD CONSTRAINT shipping_export_batches_filters_check
      CHECK (jsonb_typeof(filters) = 'object');
  END IF;
END
$shipping_exports$;

CREATE UNIQUE INDEX IF NOT EXISTS shipping_export_items_batch_order
  ON public.shipping_export_items (batch_id, order_id);
CREATE INDEX IF NOT EXISTS shipping_export_items_order
  ON public.shipping_export_items (order_id);
CREATE INDEX IF NOT EXISTS shipping_export_batches_store
  ON public.shipping_export_batches (store_id, created_at DESC);

-- ------------------------------------------------ per-courier territories
-- Cached wilaya/commune ids. Wrong commune spelling is the #1 createParcel
-- error, so the adapter resolves every destination against this table.
CREATE TABLE IF NOT EXISTS public.shipping_territories (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  provider_code text NOT NULL,
  environment   text NOT NULL,
  wilaya_code   text NOT NULL,
  commune_name  text NOT NULL DEFAULT '',
  external_id   text NOT NULL DEFAULT '',
  synced_at     timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS shipping_territories_key
  ON public.shipping_territories (tenant_id, provider_code, environment, wilaya_code, commune_name, external_id);
CREATE INDEX IF NOT EXISTS shipping_territories_lookup
  ON public.shipping_territories (tenant_id, provider_code, environment, wilaya_code);

-- ------------------------------------------------------------------- RLS
-- 011 swept the catalogue once; tables created later lock themselves. The
-- secret table gets NO policy for authenticated: only service_role (BYPASSRLS)
-- and SECURITY DEFINER RPCs can reach it. Other tables are read-only for staff,
-- scoped to their tenant; all writes go through the server-side gateway.
ALTER TABLE public.shipping_connections ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.shipping_connections FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.shipping_connections TO service_role;

ALTER TABLE public.shipments ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.shipments FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.shipments TO authenticated;
GRANT ALL ON TABLE public.shipments TO service_role;

ALTER TABLE public.shipment_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.shipment_events FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.shipment_events TO authenticated;
GRANT ALL ON TABLE public.shipment_events TO service_role;

ALTER TABLE public.shipping_export_batches ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.shipping_export_batches FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.shipping_export_batches TO authenticated;
GRANT ALL ON TABLE public.shipping_export_batches TO service_role;

ALTER TABLE public.shipping_export_items ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.shipping_export_items FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.shipping_export_items TO authenticated;
GRANT ALL ON TABLE public.shipping_export_items TO service_role;

ALTER TABLE public.shipping_territories ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.shipping_territories FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.shipping_territories TO authenticated;
GRANT ALL ON TABLE public.shipping_territories TO service_role;

DO $shipping_policies$
DECLARE
  entry record;
BEGIN
  FOR entry IN
    SELECT * FROM (VALUES
      ('shipments', 'shipping_shipments_read'),
      ('shipment_events', 'shipping_events_read'),
      ('shipping_export_batches', 'shipping_batches_read'),
      ('shipping_export_items', 'shipping_export_items_read'),
      ('shipping_territories', 'shipping_territories_read')
    ) AS t(table_name, policy_name)
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_policies
       WHERE schemaname = 'public' AND tablename = entry.table_name AND policyname = entry.policy_name
    ) THEN
      EXECUTE format(
        'CREATE POLICY %I ON public.%I FOR SELECT TO authenticated USING (tenant_id = public.current_tenant_id())',
        entry.policy_name, entry.table_name);
    END IF;
  END LOOP;
END
$shipping_policies$;

-- --------------------------------------------------------- masked read RPCs
-- The dashboard never selects shipping_connections directly. It calls this
-- definer function, which returns only non-secret columns and re-checks the
-- caller's role and branch through current_staff().
CREATE OR REPLACE FUNCTION public.engine_list_shipping_connections(p_store uuid)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  u public.users;
  v_tenant uuid;
BEGIN
  SELECT * INTO u FROM public.current_staff();
  IF u.id IS NULL OR u.role NOT IN ('owner','manager') THEN
    RAISE EXCEPTION 'إعدادات الربط متاحة للمالك أو المدير فقط';
  END IF;

  SELECT tenant_id INTO v_tenant FROM public.stores WHERE id = p_store;
  IF v_tenant IS NULL OR v_tenant IS DISTINCT FROM u.tenant_id THEN
    RAISE EXCEPTION 'غير مصرح لهذا الفرع';
  END IF;
  IF u.role <> 'owner' AND u.store_id IS DISTINCT FROM p_store THEN
    RAISE EXCEPTION 'غير مصرح لهذا الفرع';
  END IF;

  RETURN coalesce((
    SELECT jsonb_agg(jsonb_build_object(
      'id', c.id,
      'tenant_id', c.tenant_id,
      'store_id', c.store_id,
      'provider_code', c.provider_code,
      'environment', c.environment,
      'mode', c.mode,
      'enabled', c.enabled,
      'credentials_hint', c.credentials_hint,
      'origin_wilaya_code', c.origin_wilaya_code,
      'defaults', c.defaults,
      'last_test_at', c.last_test_at,
      'last_test_ok', c.last_test_ok,
      'last_test_mode', c.last_test_mode,
      'last_test_message', c.last_test_message,
      'created_at', c.created_at,
      'updated_at', c.updated_at
    ) ORDER BY c.provider_code, c.environment)
    FROM public.shipping_connections c
    WHERE c.store_id = p_store AND c.tenant_id = v_tenant
  ), '[]'::jsonb);
END $$;

REVOKE ALL ON FUNCTION public.engine_list_shipping_connections(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.engine_list_shipping_connections(uuid) TO authenticated;

-- P5 reads shipments for a branch through a definer function too, so the
-- orders screen never needs direct table grants. Snapshots are not returned.
CREATE OR REPLACE FUNCTION public.engine_list_shipments(p_store uuid)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  u public.users;
  v_tenant uuid;
BEGIN
  SELECT * INTO u FROM public.current_staff();
  IF u.id IS NULL THEN RAISE EXCEPTION 'غير مصرح'; END IF;

  SELECT tenant_id INTO v_tenant FROM public.stores WHERE id = p_store;
  IF v_tenant IS NULL OR v_tenant IS DISTINCT FROM u.tenant_id THEN
    RAISE EXCEPTION 'غير مصرح لهذا الفرع';
  END IF;
  IF u.role <> 'owner' AND u.store_id IS DISTINCT FROM p_store THEN
    RAISE EXCEPTION 'غير مصرح لهذا الفرع';
  END IF;

  RETURN coalesce((
    SELECT jsonb_agg(jsonb_build_object(
      'id', s.id,
      'order_id', s.order_id,
      'provider_code', s.provider_code,
      'environment', s.environment,
      'mode', s.mode,
      'external_id', s.external_id,
      'tracking_number', s.tracking_number,
      'status', s.status,
      'raw_status', s.raw_status,
      'label_url', s.label_url,
      'cod_amount', s.cod_amount,
      'last_synced_at', s.last_synced_at,
      'created_at', s.created_at
    ) ORDER BY s.created_at DESC)
    FROM public.shipments s
    WHERE s.store_id = p_store AND s.tenant_id = v_tenant
  ), '[]'::jsonb);
END $$;

REVOKE ALL ON FUNCTION public.engine_list_shipments(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.engine_list_shipments(uuid) TO authenticated;
