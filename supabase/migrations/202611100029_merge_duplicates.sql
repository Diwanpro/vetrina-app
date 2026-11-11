-- ============================================================================
-- 029 — customer identity: accept an explicit id, and merge existing duplicates
--
-- Order matters here. The functional fix (an RPC that accepts a customer id)
-- comes FIRST, so that if the cleanup's safety guard refuses to run, the
-- duplicate *prevention* is still in place and only the archival step is
-- blocked. The merge itself comes last.
--
-- Idempotent: a second run finds nothing to merge and changes nothing.
-- Safe on an empty database. Requires 027 (it depends on `match_key`).
-- ============================================================================

-- 027 created the column and the trigger that maintains it. Fail loudly rather
-- than half-applying if this file is run out of order.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'customers' AND column_name = 'match_key'
  ) THEN
    RAISE EXCEPTION '029 requires migration 027 (customers.match_key is missing). Apply 027 first.';
  END IF;
END $$;

-- ================================================ shared customer resolution
-- One function for the decision itself, so the credits screen and the POS
-- cannot drift apart in how they decide which customer a debt belongs to.
--
-- Order: explicit id (the cashier picked a row, nothing to match) -> exact
-- normalised phone -> normalised name -> create.
--
-- `FOUND` is tested after every SELECT INTO and carried in a boolean. Reading a
-- field of a record that was never assigned raises 55000 "record customer is
-- not assigned yet" — that mistake is what crashed every credit sale in 027.
--
-- Not granted to `authenticated`: it takes a tenant id as an argument, so a
-- direct call would let any signed-in user probe or write another tenant's
-- customers. It is only ever reached from engine_create_credit, which derives
-- the tenant from the caller's own staff row.
CREATE OR REPLACE FUNCTION public.engine_resolve_customer(
  p_tenant uuid, p_customer_id uuid, p_name text, p_phone text,
  OUT customer_id uuid, OUT customer_name text, OUT created boolean
) LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE rec public.customers; found_customer boolean := false;
        clean_name text; clean_phone text;
BEGIN
  created := false;

  IF p_customer_id IS NOT NULL THEN
    SELECT * INTO rec FROM public.customers
     WHERE id = p_customer_id AND tenant_id = p_tenant;
    found_customer := FOUND;
    -- An id belonging to another tenant is not a near miss, it is a bad request.
    IF NOT found_customer THEN
      RAISE EXCEPTION 'الزبون المحدد غير موجود في هذه المؤسسة';
    END IF;
  END IF;

  clean_name := nullif(regexp_replace(btrim(coalesce(p_name, '')), '\s+', ' ', 'g'), '');
  clean_phone := nullif(regexp_replace(btrim(coalesce(p_phone, '')), '[\s-]', '', 'g'), '');

  IF NOT found_customer AND clean_phone IS NOT NULL THEN
    -- Oldest row wins when a number was reused: the original customer is the
    -- one whose ledger carries the history.
    SELECT * INTO rec FROM public.customers
     WHERE tenant_id = p_tenant
       AND regexp_replace(coalesce(phone, ''), '[\s-]', '', 'g') = clean_phone
     ORDER BY created_at NULLS LAST, id
     LIMIT 1;
    found_customer := FOUND;
  END IF;

  IF NOT found_customer AND clean_name IS NOT NULL THEN
    SELECT * INTO rec FROM public.customers
     WHERE tenant_id = p_tenant AND match_key = public.customer_match_key(clean_name)
     ORDER BY created_at NULLS LAST, id
     LIMIT 1;
    found_customer := FOUND;
  END IF;

  IF NOT found_customer THEN
    IF clean_name IS NULL THEN
      RAISE EXCEPTION 'اسم الزبون مطلوب';
    END IF;
    -- `ON CONFLICT DO NOTHING` covers two tills creating the same customer at
    -- once: the loser's insert is dropped and the row is read back, so both
    -- sales land on one customer instead of two.
    INSERT INTO public.customers(tenant_id, name, phone)
    VALUES (p_tenant, clean_name, clean_phone)
    ON CONFLICT (tenant_id, match_key) WHERE match_key IS NOT NULL DO NOTHING
    RETURNING * INTO rec;
    found_customer := FOUND;
    created := FOUND;
    IF NOT found_customer THEN
      SELECT * INTO rec FROM public.customers
       WHERE tenant_id = p_tenant AND match_key = public.customer_match_key(clean_name)
       ORDER BY created_at NULLS LAST, id
       LIMIT 1;
      found_customer := FOUND;
    END IF;
  END IF;

  IF NOT found_customer THEN
    RAISE EXCEPTION 'تعذر تحديد الزبون لتسجيل الكريدي';
  END IF;

  customer_id := rec.id;
  customer_name := rec.name;
END $$;

REVOKE ALL ON FUNCTION public.engine_resolve_customer(uuid, uuid, text, text) FROM PUBLIC, anon, authenticated;

-- ============================================== engine_create_credit, with id
-- The 6-argument version is dropped rather than kept alongside it: leaving both
-- would let an older client resolve by name only and re-create the duplicates
-- this migration goes on to merge.
DROP FUNCTION IF EXISTS public.engine_create_credit(uuid, text, text, integer, text, date);

CREATE OR REPLACE FUNCTION public.engine_create_credit(
  p_store uuid, p_name text, p_phone text, p_amount integer,
  p_description text, p_due_date date, p_customer_id uuid DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE u public.users; resolved record; credit_id uuid;
BEGIN
  SELECT * INTO u FROM public.current_staff();
  PERFORM public.engine_validate(p_store, u.tenant_id, ARRAY['owner','manager','employee']);

  IF p_amount IS NULL OR p_amount <= 0 OR p_amount > 2147483647 THEN
    RAISE EXCEPTION 'المبلغ غير صالح';
  END IF;

  SELECT * INTO resolved
    FROM public.engine_resolve_customer(u.tenant_id, p_customer_id, p_name, p_phone);

  INSERT INTO public.credits(store_id, created_by, customer_id, total_amount, remaining_amount, description, due_date, status)
  VALUES (p_store, u.id, resolved.customer_id, p_amount, p_amount,
          nullif(btrim(coalesce(p_description, '')), ''), p_due_date, 'active')
  RETURNING id INTO credit_id;

  RETURN jsonb_build_object(
    'creditId', credit_id,
    'customerId', resolved.customer_id,
    'customerName', resolved.customer_name,
    'createdCustomer', resolved.created
  );
END $$;

REVOKE ALL ON FUNCTION public.engine_create_credit(uuid, text, text, integer, text, date, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.engine_create_credit(uuid, text, text, integer, text, date, uuid) TO authenticated;

-- ============================================================ merge duplicates
-- Two traps shape this block.
--
-- 1. Grouping on the stored `match_key` finds NOTHING. 027 could not create its
--    unique index while two rows shared a key, so it gave every loser a suffixed
--    one (`ali#<uuid>`). Rows that look duplicated in the data have distinct
--    keys by design. The group key is therefore recomputed from `name`.
--
-- 2. Grouping on name alone is dangerous in a country where "محمد" and "أحمد"
--    are in every street. Merging two different people fuses two real debts into
--    one ledger and there is no way back, so the phone is used as a discriminator
--    whenever it can be:
--
--      * one number for the name  -> all rows with that name merge, including
--                                    rows where the phone was left blank
--      * several numbers          -> only rows sharing an identical number
--                                    merge, and the ambiguous groups are
--                                    reported so a human can look
--
--    "Merge duplicate customers" is not worth corrupting a ledger over. When in
--    doubt this migration leaves rows alone and says so.
DO $$
DECLARE offenders text; merged bigint := 0; moved bigint := 0; groups bigint := 0;
        ambiguous text;
BEGIN
  -- The merge assumes `credits` is the only table holding a customer id. If a
  -- later schema change adds another, merging would orphan those rows — note
  -- that `credit_payments` reaches a customer through `credit_id`, not directly,
  -- which is why this guard is expected to pass today.
  SELECT string_agg(table_name || '.' || column_name, ', ' ORDER BY table_name) INTO offenders
    FROM information_schema.columns
   WHERE table_schema = 'public'
     AND column_name = 'customer_id'
     AND table_name NOT IN ('credits', 'customers');
  IF offenders IS NOT NULL THEN
    RAISE EXCEPTION '029: customer_id also exists on: %. Re-point those rows in this migration before merging.', offenders;
  END IF;

  -- Writes are held off while the plan is built and applied: a customer created
  -- between the two steps could otherwise be deleted by a stale plan.
  LOCK TABLE public.customers IN SHARE ROW EXCLUSIVE MODE;
  LOCK TABLE public.credits   IN SHARE ROW EXCLUSIVE MODE;

  DROP TABLE IF EXISTS merge_plan, merge_ambiguous;
  CREATE TEMP TABLE merge_plan AS
    WITH base AS (
      SELECT id, tenant_id, created_at,
             public.customer_match_key(name) AS base_key,
             nullif(regexp_replace(coalesce(phone, ''), '[\s-]', '', 'g'), '') AS norm_phone
        FROM public.customers
       WHERE public.customer_match_key(name) IS NOT NULL
    ), per_name AS (
      SELECT tenant_id, base_key, count(DISTINCT norm_phone) AS distinct_phones
        FROM base
       WHERE norm_phone IS NOT NULL
       GROUP BY tenant_id, base_key
    ), keyed AS (
      SELECT b.id, b.tenant_id, b.created_at, b.base_key,
             CASE WHEN coalesce(n.distinct_phones, 0) <= 1
                  THEN ''                       -- one number (or none): safe to merge
                  ELSE coalesce(b.norm_phone, '') -- several: only identical numbers
             END AS group_key
        FROM base b
        LEFT JOIN per_name n ON n.tenant_id = b.tenant_id AND n.base_key = b.base_key
    ), ranked AS (
      SELECT id,
             first_value(id) OVER (
               PARTITION BY tenant_id, base_key, group_key
               ORDER BY created_at NULLS LAST, id
             ) AS keep_id
        FROM keyed
    )
    -- `keep_id <> id` is what makes a second run a no-op.
    SELECT id AS dup_id, keep_id FROM ranked WHERE keep_id <> id;

  -- Same number, different people is a real possibility; never merge, but name
  -- them so the shop can merge by hand if it wants to.
  CREATE TEMP TABLE merge_ambiguous AS
    WITH base AS (
      SELECT tenant_id, public.customer_match_key(name) AS base_key,
             count(DISTINCT nullif(regexp_replace(coalesce(phone, ''), '[\s-]', '', 'g'), '')) AS distinct_phones
        FROM public.customers
       WHERE public.customer_match_key(name) IS NOT NULL
       GROUP BY tenant_id, public.customer_match_key(name)
    )
    SELECT tenant_id, base_key, distinct_phones FROM base WHERE distinct_phones > 1;

  SELECT count(DISTINCT keep_id) INTO groups FROM merge_plan;

  IF groups = 0 THEN
    RAISE NOTICE '029: no duplicate customers to merge';
  ELSE
    -- Debts first. Every other reader reaches a customer through `credits`, so
    -- moving these rows carries the history across with no further work.
    UPDATE public.credits c
       SET customer_id = p.keep_id
      FROM merge_plan p
     WHERE c.customer_id = p.dup_id;
    GET DIAGNOSTICS moved = ROW_COUNT;

    -- Belt and braces: never let the delete below orphan a debt.
    IF EXISTS (SELECT 1 FROM public.credits c JOIN merge_plan p ON c.customer_id = p.dup_id) THEN
      RAISE EXCEPTION '029: credits still reference duplicate customers after re-pointing; aborting';
    END IF;

    DELETE FROM public.customers c USING merge_plan p WHERE c.id = p.dup_id;
    GET DIAGNOSTICS merged = ROW_COUNT;
  END IF;

  -- The survivors must own their base key again: the kept row may be one that
  -- 027 suffixed. Only safe AFTER the deletes, which is why it runs last.
  UPDATE public.customers
     SET match_key = public.customer_match_key(name)
   WHERE public.customer_match_key(name) IS NOT NULL
     AND match_key IS DISTINCT FROM public.customer_match_key(name);

  SELECT string_agg(base_key || ' (' || distinct_phones || ' أرقام)', ', ') INTO ambiguous
    FROM merge_ambiguous;
  IF ambiguous IS NOT NULL THEN
    RAISE NOTICE '029: left these names unmerged because they have several phone numbers: %', ambiguous;
  END IF;

  RAISE NOTICE '029: merged % duplicate customer rows across % customers, re-pointed % credit rows',
    merged, groups, moved;

  DROP TABLE IF EXISTS merge_plan, merge_ambiguous;
END $$;
