-- ============================================================================
-- seed_history.sql — 7 days of activity (6 past days + today) for ONE tenant
--
-- Run by hand in the Supabase SQL editor, AFTER seed_data.sql. This is NOT a
-- migration: nothing depends on it, so it stays out of the numbered sequence.
-- seed_data.sql is never modified by this file.
--
-- ── Why it is a separate file ───────────────────────────────────────────────
-- seed_data.sql deliberately refuses to touch the drawer: its sales carry
-- cash_amount = 0 and it writes exactly one closed shift, so a demo can never
-- make a real reconciliation wrong. That is the right default for a live shop,
-- and the wrong one for a demo whose whole point is a populated dashboard.
-- Keeping the two apart means the cautious seed stays cautious and the loud one
-- is opt-in.
--
-- ── What it creates ─────────────────────────────────────────────────────────
--   * 5 closed shifts (days 6…2 ago) + one OPEN shift today. Day 1 is skipped
--     when seed_data.sql already closed yesterday — two closes for one date
--     would double every daily total in the reports.
--   * one day_closes per closed shift (one comes up 500 short)
--   * 24 sales: 4/day for days 6…2, a whole-look sale and an offer sale
--   * 25 sales over the 7 days, with their sale_items and the stock movement
--   * a whole-look sale (Sale A) and a "2 for 3000" offer sale (Sale B)
--   * 5 customers: 4 with historical debts, plus يوسف بن علي today
--   * 5 credits (paid / partial / two overdue / today's), with credit_payments
--   * 11 expenses over the week, including today's three
--   * 1 purchase from a supplier 5 days ago + its lines + a partial payment
--   * 2 employee advances today + 1 payroll run 3 days ago
--
-- ── Rules this file follows ─────────────────────────────────────────────────
--   1. Direct `INSERT INTO` only. No RPCs. Every engine_* function is
--      SECURITY DEFINER behind current_staff(), which is keyed on auth.uid():
--      this script runs in the SQL editor as `postgres` with no JWT, so
--      current_staff() resolves nothing and every RPC would raise before
--      writing a row. Same reason seed_data.sql writes its rows itself.
--   2. Generated columns are never named. day_closes.difference is
--      GENERATED ALWAYS AS (actual_cash - expected_cash) STORED and rejects
--      any supplied value with 428C9. shifts.difference is the opposite — a
--      plain writable column — and is written. The two look alike and are not.
--   3. Every date is relative: now() - interval 'N days'. Nothing is absolute,
--      so the file is still correct next month.
--
-- ── The cash rule, which is the one thing to read before editing ────────────
-- A day's cash_sales figures are written by the sale insert itself and then
-- read back from `sales` with a window that cannot overlap another day:
--
--     expected = opening float + cash sales in [D+9h, D+18h)
--                                   − expenses   in [D+9h, D+18h)
--
-- Sales land at +10…+15h and expenses at +10h, both inside that window, so the
-- shift, the day close and the rows themselves agree instead of being three
-- sets of typed-in numbers that happen to look plausible.
--
-- ── Idempotency ─────────────────────────────────────────────────────────────
-- Every row carries a marker: `hist:` local_ids / request_ids (all fixed uuids
-- or fixed strings), `[hist]` in notes and descriptions, and customer phones
-- from a reserved 05/06/07 010100x block. A second run finds its own work and
-- skips it. Nothing is truncated or deleted. Stock IS decremented, and only by
-- the rows created on the first run.
--
-- ── Warnings ────────────────────────────────────────────────────────────────
--   * It picks the same tenant as seed_data.sql (the one with most stores).
--     Set tenant_override to target another.
--   * It adds ~25 fake invoices to real reports if run on a live shop.
--   * It moves stock and cash. Use a demo tenant.
--   * It raises if the tenant has no open branch, or no product to sell.
--
-- Requires 202611120012 or later (looks) and 202611120014 or later recommended.
-- ============================================================================

DO $hist$
DECLARE
  tag constant text := '[hist]';
  -- NULL = same rule as seed_data.sql: the tenant with the most stores.
  tenant_override constant uuid := NULL;

  v_tenant uuid; v_owner uuid;
  v_store1 uuid; v_store2 uuid;
  v_employee uuid;
  v_day integer;
  v_date date;
  v_created timestamptz;

  v_shift uuid;
  v_cash bigint;
  v_spent bigint;
  v_expected bigint;
  v_actual bigint;
  -- Deliberate shortages: one day comes up 500 short, the rest tie out.
  v_short integer;

  -- Today's numbers.
  v_sales_per_day constant integer := 4;
  v_today_total integer := 0;
  v_opening integer;

  v_sale uuid;
  v_product uuid; v_variant uuid;
  v_qty integer; v_price integer; v_cost numeric;
  v_total integer;
  v_customer_id uuid;
  v_credit uuid;
  v_look uuid; v_look_price integer;
  v_offer uuid; v_offer_price integer;
  v_expense_desc text;
  v_name text;

  -- Items of the look used for Sale A: product_id → unit price, so the sale's
  -- lines are the outfit's own pieces at the outfit's own split of the price.
  v_look_units jsonb;
  v_look_gross integer; v_look_count integer;
  v_piece record; v_unit integer;
  v_seen integer; v_allocated integer;
BEGIN
  -- ============================================================ the tenant
  -- Same resolution as seed_data.sql, so the two files land in one shop.
  v_tenant := tenant_override;
  IF v_tenant IS NULL THEN
    SELECT t.id INTO v_tenant
      FROM public.tenants t
     ORDER BY (SELECT count(*) FROM public.stores s WHERE s.tenant_id = t.id) DESC, t.id
     LIMIT 1;
  END IF;
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'لا توجد مؤسسة في قاعدة البيانات. أنشئ حساباً أولاً.';
  END IF;

  SELECT u.id INTO v_owner
    FROM public.users u
   WHERE u.tenant_id = v_tenant AND u.role IN ('owner', 'manager')
   ORDER BY CASE u.role WHEN 'owner' THEN 0 ELSE 1 END, u.created_at NULLS LAST, u.id
   LIMIT 1;
  IF v_owner IS NULL THEN
    RAISE EXCEPTION 'المؤسسة % لا تحتوي على مالك أو مدير؛ لا يمكن تسجيل مبيعات باسم أحد.', v_tenant;
  END IF;

  -- A payroll row needs a non-owner user: engine_pay_salary only pays roles
  -- manager/employee. NULL is tolerated — the payroll block is then skipped
  -- rather than writing a row that names the owner as his own employee.
  SELECT u.id INTO v_employee
    FROM public.users u
   WHERE u.tenant_id = v_tenant AND u.role IN ('manager', 'employee')
   ORDER BY CASE u.role WHEN 'manager' THEN 0 ELSE 1 END, u.created_at NULLS LAST, u.id
   LIMIT 1;

  -- ================================================================ branches
  -- The main branch is the same one seed_data.sql treats as primary. The
  -- second branch only appears if the seed created it; the whole script works
  -- with one.
  SELECT s.id INTO v_store1
    FROM public.stores s WHERE s.tenant_id = v_tenant
   ORDER BY s.created_at NULLS LAST, s.id LIMIT 1;
  IF v_store1 IS NULL THEN
    RAISE EXCEPTION 'المؤسسة % لا تحتوي على فرع؛ أنشئ فرعاً أولاً.', v_tenant;
  END IF;

  SELECT s.id INTO v_store2
    FROM public.stores s WHERE s.tenant_id = v_tenant AND s.id <> v_store1
   ORDER BY s.created_at NULLS LAST, s.id LIMIT 1;

  RAISE NOTICE 'seed_history: المؤسسة % · الفرع %', v_tenant, v_store1;

  -- =============================================================== customers
  -- Four historical debtors plus today's new one. Phones sit in the reserved
  -- 010100x block so a re-run recognises them and a real customer can never
  -- collide with a demo one. match_key is left to the trigger/default — it is
  -- derived from the name and phone, and writing it by hand would drift.
  INSERT INTO public.customers(tenant_id, name, phone)
  SELECT v_tenant, x.name, x.phone
    FROM (VALUES
      (tag || ' ياسين بوزيد',   '0550101001'),
      (tag || ' سارة حمداوي',   '0660101002'),
      (tag || ' أمين بن عيسى',  '0770101003'),
      (tag || ' نهاد مرابط',    '0550101004'),
      -- Today's credit customer, named in the brief.
      ('يوسف بن علي',           '0660101005')
    ) AS x(name, phone)
   WHERE NOT EXISTS (
     SELECT 1 FROM public.customers c WHERE c.tenant_id = v_tenant AND c.phone = x.phone);

  -- ======================================= closed shifts + day closes, days 6…1
  -- v_day is "how many days ago": 6 down to 1, so nothing is written for today
  -- here — today's shift is opened further down, after today's sales exist.
  FOR v_day IN REVERSE 6 .. 1 LOOP
    v_date := (date_trunc('day', now()) - v_day * interval '1 day')::date;

    -- One close per calendar day, whoever wrote it.
    --
    -- seed_data.sql already writes a closed shift and a day close for
    -- YESTERDAY at this branch, and it is meant to be run first. Adding a
    -- second pair for the same date would not fail — there is no unique key on
    -- day_closes — it would silently double every daily total in the reports,
    -- which is worse. So a date that already has a close is left alone, and its
    -- sales (seed_data wrote several that day) stay as they are. That day is
    -- still covered; it is just covered by the other file.
    CONTINUE WHEN EXISTS (
      SELECT 1 FROM public.day_closes dc
       WHERE dc.store_id = v_store1 AND dc.date = v_date);

    -- Already done by a previous run of this file? The note always ends with
    -- the opening float, so LIKE is used rather than =: an equality check would
    -- never match its own row.
    CONTINUE WHEN EXISTS (
      SELECT 1 FROM public.shifts s
       WHERE s.store_id = v_store1 AND s.notes LIKE tag || ' وردية %' AND s.closed_at::date = v_date);

    -- -- the day's invoices ------------------------------------------------
    -- 4 per day, ids 101…124, alternating cash/credit. Amounts come from the
    -- catalogue's own base_price, never from a number typed here, so the totals
    -- on screen match the products on screen.
    FOR i IN 1 .. v_sales_per_day LOOP
      -- Sale A replaces the whole look sale inserted below, so it is not
      -- duplicated here; the loop skips id 2 on day 3 to leave room for it.
      CONTINUE WHEN v_day = 3 AND i = 2;

      v_created := date_trunc('day', now()) - v_day * interval '1 day'
                   + (9 + i) * interval '1 hour';   -- +10h … +13h

      CONTINUE WHEN EXISTS (
        SELECT 1 FROM public.sales x
         WHERE x.store_id = v_store1
           AND x.local_id = 'hist:sale:' || v_day || ':' || i);

      -- Round-robin over the products the seed actually created, by name.
      -- OFFSET + LIMIT picks a different product per (day, i) without having
      -- to know any uuid.
      SELECT p.id, pv.id, p.base_price, coalesce(pv.cost_price_avg, 0)
        INTO v_product, v_variant, v_price, v_cost
        FROM public.products p
        JOIN public.product_variants pv ON pv.product_id = p.id
       WHERE p.tenant_id = v_tenant AND p.is_active
       ORDER BY p.name, pv.size
       OFFSET ((v_day * v_sales_per_day + i) * 3) % 40
       LIMIT 1;
      CONTINUE WHEN v_variant IS NULL;   -- tenant has no catalogue yet

      v_qty   := 1 + ((v_day + i) % 2);   -- 1 or 2
      v_total := v_price * v_qty;

      INSERT INTO public.sales(store_id, user_id, total_amount, cash_amount,
                               payment_method, status, local_id, synced_at, created_at)
      VALUES (
        -- A third of the invoices go to the second branch, when it exists.
        CASE WHEN v_store2 IS NOT NULL AND i = 4 THEN v_store2 ELSE v_store1 END,
        v_owner, v_total,
        -- cash_amount is what the drawer really took. A credit invoice takes
        -- nothing, so 0 — not the total. This is the column the shift
        -- reconciliation sums.
        CASE WHEN i % 3 = 0 THEN 0 ELSE v_total END,
        CASE WHEN i % 3 = 0 THEN 'credit' ELSE 'cash' END,
        -- 'completed', never 'synced': status is the invoice lifecycle, and
        -- every financial query filters on it. synced_at carries "it is in".
        'completed', 'hist:sale:' || v_day || ':' || i, v_created, v_created)
      RETURNING id INTO v_sale;

      INSERT INTO public.sale_items(sale_id, variant_id, quantity, original_price,
                                    final_price, unit_price, subtotal, cost_at_sale)
      VALUES (v_sale, v_variant, v_qty, v_price, v_price, v_price, v_total, v_cost);

      -- Stock left the shelf with the invoice. greatest(...,0) because the
      -- inventory row may not exist for a branch the seed never stocked.
      UPDATE public.inventory
         SET quantity = greatest(quantity - v_qty, 0), updated_at = now()
       WHERE variant_id = v_variant
         AND store_id = (SELECT store_id FROM public.sales WHERE id = v_sale);
    END LOOP;

    -- -- Sale A: a whole outfit, three days ago ----------------------------
    -- The look is priced by its own bundle_price, split across its pieces by
    -- roughly the same rule looks_bundle_units() uses (price-proportional).
    -- Both pieces are sold, so the invoice total is the outfit price and the
    -- lines add up to it exactly — a report that sums sale_items and one that
    -- sums sales.total_amount must not disagree.
    IF v_day = 3 AND NOT EXISTS (
      SELECT 1 FROM public.sales x WHERE x.store_id = v_store1 AND x.local_id = 'hist:look:1') THEN
      -- The look and the gross value of its pieces, so each share can be
      -- scaled from the outfit price.
      SELECT l.id, l.bundle_price,
             (SELECT sum(p.base_price)
                FROM public.look_items li JOIN public.products p ON p.id = li.product_id
               WHERE li.look_id = l.id)
        INTO v_look, v_look_price, v_look_gross
        FROM public.looks l
       WHERE l.tenant_id = v_tenant AND l.bundle_price > 0
       ORDER BY l.name LIMIT 1;

      IF v_look IS NOT NULL AND coalesce(v_look_gross, 0) > 0 THEN
        -- One unit price per piece, proportional to its own price, computed in
        -- a plain loop rather than one clever query. The last piece absorbs the
        -- rounding remainder, so the lines always add up to bundle_price
        -- exactly — a report that sums sale_items and one that sums
        -- sales.total_amount must never disagree.
        SELECT count(*) INTO v_look_count
          FROM public.look_items li WHERE li.look_id = v_look;

        v_look_units := '{}'::jsonb;
        v_allocated  := 0;
        v_seen       := 0;
        FOR v_piece IN
          SELECT p.id, p.base_price
            FROM public.look_items li JOIN public.products p ON p.id = li.product_id
           WHERE li.look_id = v_look
           ORDER BY p.name, p.id
        LOOP
          v_seen := v_seen + 1;
          IF v_seen = v_look_count THEN
            v_unit := v_look_price - v_allocated;   -- remainder on the last piece
          ELSE
            v_unit := floor(v_look_price * v_piece.base_price::numeric / v_look_gross)::integer;
            v_allocated := v_allocated + v_unit;
          END IF;
          v_look_units := v_look_units || jsonb_build_object(v_piece.id::text, v_unit);
        END LOOP;

        v_total := v_look_price;
        INSERT INTO public.sales(store_id, user_id, total_amount, cash_amount,
                                 payment_method, status, local_id, synced_at, created_at, note)
        VALUES (v_store1, v_owner, v_total, v_total, 'cash', 'completed',
                'hist:look:1',
                date_trunc('day', now()) - 3 * interval '1 day' + interval '14 hours',
                date_trunc('day', now()) - 3 * interval '1 day' + interval '14 hours',
                tag || ' بيع إطلالة كاملة')
        RETURNING id INTO v_sale;

        -- One line per piece, at the outfit's unit price. Nothing is written
        -- when the look has no priced pieces, rather than a zero-value line.
        INSERT INTO public.sale_items(sale_id, variant_id, quantity, original_price,
                                      final_price, unit_price, subtotal, cost_at_sale)
        SELECT v_sale, pv.id, 1, p.base_price,
               coalesce((v_look_units ->> p.id::text)::integer, p.base_price),
               coalesce((v_look_units ->> p.id::text)::integer, p.base_price),
               coalesce((v_look_units ->> p.id::text)::integer, p.base_price),
               coalesce(pv.cost_price_avg, 0)
          FROM public.look_items li
          JOIN public.products p ON p.id = li.product_id
          JOIN LATERAL (
            SELECT id, cost_price_avg FROM public.product_variants
             WHERE product_id = p.id ORDER BY size LIMIT 1
          ) pv ON true
         WHERE li.look_id = v_look;

        UPDATE public.inventory i
           SET quantity = greatest(i.quantity - 1, 0), updated_at = now()
          FROM public.sale_items si
         WHERE si.sale_id = v_sale AND i.variant_id = si.variant_id AND i.store_id = v_store1;
      END IF;
    END IF;

    -- -- Sale B: the "2 for 3000" offer, two days ago -----------------------
    -- Two units of one product on a live bundle offer: the lines carry the
    -- offer price and offer_id, and the invoice total is what the customer
    -- actually handed over — 3000, not 2 × base_price.
    IF v_day = 2 AND NOT EXISTS (
      SELECT 1 FROM public.sales x WHERE x.store_id = v_store1 AND x.local_id = 'hist:offer:1') THEN
      SELECT o.id, o.offer_price, o.product_id INTO v_offer, v_offer_price, v_product
        FROM public.offers o
       WHERE o.tenant_id = v_tenant
         AND coalesce(o.is_active, true)
         AND o.required_qty = 2
         AND o.offer_price IS NOT NULL
       ORDER BY o.created_at NULLS LAST, o.id
       LIMIT 1;

      IF v_offer IS NOT NULL THEN
        SELECT pv.id, pv.cost_price_avg, p.base_price
          INTO v_variant, v_cost, v_price
          FROM public.product_variants pv
          JOIN public.products p ON p.id = pv.product_id
         WHERE pv.product_id = v_product
         ORDER BY pv.size LIMIT 1;

        IF v_variant IS NOT NULL THEN
          INSERT INTO public.sales(store_id, user_id, total_amount, cash_amount,
                                   payment_method, status, local_id, synced_at, created_at, note)
          VALUES (v_store1, v_owner, v_offer_price * (v_offer_price / v_offer_price)::integer,
                  v_offer_price, 'cash', 'completed', 'hist:offer:1',
                  date_trunc('day', now()) - 2 * interval '1 day' + interval '15 hours',
                  date_trunc('day', now()) - 2 * interval '1 day' + interval '15 hours',
                  tag || ' عرض 2 بسعر مخفّض')
          RETURNING id INTO v_sale;

          INSERT INTO public.sale_items(sale_id, variant_id, quantity, original_price,
                                        final_price, unit_price, subtotal, cost_at_sale, offer_id)
          VALUES (v_sale, v_variant, 2, v_price, v_offer_price, v_offer_price / 2,
                  v_offer_price, coalesce(v_cost, 0), v_offer);

          UPDATE public.inventory
             SET quantity = greatest(quantity - 2, 0), updated_at = now()
           WHERE variant_id = v_variant AND store_id = v_store1;
        END IF;
      END IF;
    END IF;

    -- -- the shift, from what was just written ------------------------------
    -- cash_sales is read back, not typed: the sum of the day's completed cash
    -- invoices in this branch. A credit invoice contributes 0 by construction.
    SELECT coalesce(sum(x.cash_amount), 0) INTO v_cash
      FROM public.sales x
     WHERE x.store_id = v_store1 AND x.status = 'completed'
       AND x.created_at >= date_trunc('day', now()) - v_day * interval '1 day' + interval '9 hours'
       AND x.created_at <  date_trunc('day', now()) - v_day * interval '1 day' + interval '18 hours';

    -- -- the day's expenses ------------------------------------------------
    -- Written here, after the sales and before the shift, because a drawer
    -- cannot be reconciled against spending it has not been told about yet.
    --
    -- Amounts are sized to the day's own takings. A flat 35 000 rent against
    -- 17 000 of daily cash sales used to drive expected_cash NEGATIVE — a shop
    -- whose till goes below zero overnight is not a plausible demo. Rent is a
    -- monthly item, so it is charged once, on the strongest day, as a partial
    -- payment; everything else is small and fixed.
    --
    -- request_id is a uuid column with a unique index, so 'hist:expense:3:1'
    -- cannot go in it. A fixed uuid derived from (day, slot) is used instead:
    -- constants, so the same key yields the same row on every run.
    FOR i IN 1 .. 2 LOOP
      -- Two expenses on even days, one on odd ones.
      CONTINUE WHEN i = 2 AND v_day % 2 = 1;

      CONTINUE WHEN EXISTS (
        SELECT 1 FROM public.expenses e
         WHERE e.request_id = ('00000000-0000-4000-8000-0000'
                               || lpad((v_day * 10 + i)::text, 8, '0'))::uuid);

      IF i = 1 AND v_day = 3 THEN
        -- The rent: the biggest charge of the week, capped at half the day's
        -- cash so the float is never overrun.
        v_name := 'إيجار';
        v_price := greatest(0, least(12000, floor(v_cash::numeric / 2)::integer));
        v_expense_desc := tag || ' دفعة إيجار المحل';
      ELSE
        v_name := (ARRAY['كهرباء وماء', 'نقل', 'أخرى', 'صيانة'])[1 + ((v_day + i) % 4)];
        v_price := (ARRAY[3500, 2000, 1500, 1200])[1 + ((v_day + i) % 4)];
        v_expense_desc := tag || ' ' || (ARRAY['فاتورة كهرباء', 'نقل بضاعة', 'أكياس وتغليف', 'صيانة دورية'])[1 + ((v_day + i) % 4)];
      END IF;

      -- Skipped rather than written at zero: a 0-dinar expense is noise in the
      -- ledger and would make the demo look broken.
      CONTINUE WHEN v_price <= 0;

      INSERT INTO public.expenses(store_id, amount, description, category, receipt_url,
                                  created_by, status, request_id, created_at)
      VALUES (v_store1, v_price, v_expense_desc, v_name,
              -- A placeholder, not NULL: the column's nullability was never
              -- verified, and a fake path that resolves to nothing is better
              -- than a 23502 that stops the whole script.
              'https://example.com/seed-receipt.jpg',
              v_owner, 'approved',
              ('00000000-0000-4000-8000-0000' || lpad((v_day * 10 + i)::text, 8, '0'))::uuid,
              -- Inside the shift window, so the reconciliation sees it.
              date_trunc('day', now()) - v_day * interval '1 day'
                + interval '10 hours' + (i - 1) * interval '30 minutes');
    END LOOP;

    -- Cash that left the drawer during the shift: the same [9h, 18h) window the
    -- sales above were counted in, which is exactly what engine_close_shift()
    -- subtracts. Soft-deleted expenses are excluded, as everywhere else.
    SELECT coalesce(sum(x.amount), 0) INTO v_spent
      FROM public.expenses x
     WHERE x.store_id = v_store1 AND x.deleted_at IS NULL
       AND x.created_at >= date_trunc('day', now()) - v_day * interval '1 day' + interval '9 hours'
       AND x.created_at <  date_trunc('day', now()) - v_day * interval '1 day' + interval '18 hours';

    v_expected := 10000 + v_cash - v_spent;      -- 10 000 float + taken − spent

    -- One short day in the window, not one per file.
    --
    -- seed_data.sql already writes a -500 close for yesterday, so hardcoding a
    -- second one here would put two unexplained shortages in a seven-day demo.
    -- The short day is therefore chosen only when the window does not already
    -- contain one, and it prefers the middle of the week so the chart is not
    -- lopsided.
    v_short := CASE
                 WHEN v_day = 4 AND NOT EXISTS (
                   SELECT 1 FROM public.day_closes dc
                    WHERE dc.store_id = v_store1 AND dc.difference <> 0
                      AND dc.date > (date_trunc('day', now()) - 7 * interval '1 day')::date)
                 THEN 500 ELSE 0 END;
    v_actual   := v_expected - v_short;

    INSERT INTO public.shifts(store_id, user_id, status, start_time, end_time,
                              expected_cash, actual_cash, difference, total_cash_sales,
                              notes, closed_at)
    VALUES (v_store1, v_owner, 'closed',
            date_trunc('day', now()) - v_day * interval '1 day' + interval '9 hours',
            date_trunc('day', now()) - v_day * interval '1 day' + interval '18 hours',
            v_expected, v_actual, v_actual - v_expected, v_cash,
            tag || ' وردية ' || v_date || ' — الرصيد الافتتاحي 10000'
              || CASE WHEN v_short = 0 THEN '' ELSE ' · نقص 500 دج' END,
            date_trunc('day', now()) - v_day * interval '1 day' + interval '18 hours')
    RETURNING id INTO v_shift;

    -- The daily close that pairs with it. Same numbers by construction, so the
    -- two screens cannot tell different stories.
    --
    -- `difference` is ABSENT on purpose: day_closes.difference is GENERATED
    -- ALWAYS AS (actual_cash - expected_cash) STORED and Postgres rejects any
    -- value supplied for it with 428C9 — including the correct one. Writing the
    -- expression out fails exactly as writing a number does; the column
    -- computes itself from the two values below.
    INSERT INTO public.day_closes(store_id, date, expected_cash, actual_cash,
                                  notes, closed_at)
    VALUES (v_store1, v_date, v_expected, v_actual,
            tag || CASE WHEN v_short = 0 THEN ' تقفيلة متوازنة' ELSE ' تقفيلة — نقص 500 دج غير مبرر' END,
            date_trunc('day', now()) - v_day * interval '1 day' + interval '18 hours');
  END LOOP;

  -- ============================================ historical credits (days 6…1)
  -- Four debts over the week, one per state the credits screen can draw:
  -- fully paid, partially paid, and two that are overdue.
  --
  -- credit_payments is written for the paid and the partial one so the
  -- customer ledger has movements to show; a credit whose remaining_amount
  -- dropped without a payment row would read as a bug in the ledger.
  FOR i IN 1 .. 4 LOOP
    -- Names are resolved by phone, not by uuid: one row per demo customer.
    SELECT c.id INTO v_customer_id
      FROM public.customers c
     WHERE c.tenant_id = v_tenant
       AND c.phone = (ARRAY['0550101001', '0660101002', '0770101003', '0550101004'])[i];

    CONTINUE WHEN v_customer_id IS NULL;

    CONTINUE WHEN EXISTS (
      SELECT 1 FROM public.credits cr
       WHERE cr.store_id = v_store1 AND cr.customer_id = v_customer_id
         AND cr.description LIKE tag || '%');

    v_total := (ARRAY[8000, 12000, 6500, 9500])[i];
    v_created := date_trunc('day', now()) - (7 - i) * interval '1 day' + interval '11 hours';

    INSERT INTO public.credits(store_id, created_by, customer_id, total_amount,
                               remaining_amount, due_date, status, description, created_at)
    VALUES (v_store1, v_owner, v_customer_id, v_total,
            -- 1: nothing left · 2: half paid · 3 & 4: untouched and overdue.
            CASE i WHEN 1 THEN 0 WHEN 2 THEN v_total / 2 ELSE v_total END,
            CASE i
              WHEN 1 THEN (v_created + interval '15 days')::date
              WHEN 2 THEN (v_created + interval '20 days')::date
              -- Overdue: the due date is already ten days in the past.
              ELSE (now() - interval '10 days')::date
            END,
            CASE i WHEN 1 THEN 'paid' ELSE 'active' END,
            tag || ' دين ' || (ARRAY['مسدّد', 'مسدّد جزئياً', 'متأخر', 'متأخر'])[i],
            v_created)
    RETURNING id INTO v_credit;

    -- Payment history for the two that have one.
    IF i IN (1, 2) THEN
      INSERT INTO public.credit_payments(credit_id, amount, paid_at, created_by,
                                         store_id, payment_method, created_at)
      VALUES (v_credit,
              CASE i WHEN 1 THEN v_total ELSE v_total - v_total / 2 END,
              v_created + interval '2 days',
              v_owner, v_store1, 'cash',
              v_created + interval '2 days');
    END IF;
  END LOOP;

  -- ================================================== supplier & purchase
  -- A purchase five days ago and a partial payment three days later, so the
  -- supplier ledger shows a debt that is being worked down rather than a
  -- single number.
  --
  -- The purchase is written by hand for the same auth reason as everything
  -- else, and it reproduces what engine_receive_purchase() does: the purchase
  -- row, its lines, the stock increment and the weighted cost average. The
  -- supplier's total_debt is set to the unpaid remainder, which is what
  -- engine_pay_supplier() checks a payment against.
  DECLARE
    v_supplier uuid;
    v_purchase uuid;
    v_total_cost integer := 50000;
    v_paid integer := 20000;
    v_purchased_at timestamptz := date_trunc('day', now()) - 5 * interval '1 day' + interval '10 hours';
  BEGIN
    SELECT sp.id INTO v_supplier
      FROM public.suppliers sp
     WHERE sp.tenant_id = v_tenant
     ORDER BY sp.name LIMIT 1;

    -- No supplier in the tenant: create one rather than skipping the whole
    -- block, because the purchase is a required part of the demo.
    IF v_supplier IS NULL THEN
      INSERT INTO public.suppliers(tenant_id, name, phone, supplied_goods, total_debt)
      VALUES (v_tenant, tag || ' مورد الجملة', '0550101301', 'ملابس وأحذية بالجملة', 0)
      RETURNING id INTO v_supplier;
    END IF;

    IF NOT EXISTS (SELECT 1 FROM public.purchases p
                    WHERE p.request_id = '00000000-0000-4000-8000-0000000a0001'::uuid) THEN
      INSERT INTO public.purchases(store_id, tenant_id, supplier_id, supplier_name,
                                   total_amount, status, created_by, request_id,
                                   request_items, created_at)
      VALUES (v_store1, v_tenant, v_supplier, tag || ' مورد الجملة',
              v_total_cost, 'received', v_owner,
              '00000000-0000-4000-8000-0000000a0001'::uuid,
              '[]'::jsonb, v_purchased_at)
      RETURNING id INTO v_purchase;

      -- Two lines, each 10 units at half the invoice. unit_cost comes from the
      -- variant's recorded cost so the purchase agrees with the cost history
      -- rather than inventing a price.
      FOR i IN 1 .. 2 LOOP
        SELECT pv.id, coalesce(pv.cost_price_avg, 0)::integer INTO v_variant, v_price
          FROM public.product_variants pv
          JOIN public.products p ON p.id = pv.product_id
         WHERE p.tenant_id = v_tenant AND p.is_active
         ORDER BY p.name, pv.size
         OFFSET (i * 5) LIMIT 1;
        CONTINUE WHEN v_variant IS NULL;

        INSERT INTO public.purchase_items(purchase_id, variant_id, quantity, unit_cost,
                                          tenant_id, store_id, created_at)
        VALUES (v_purchase, v_variant, 10, greatest(v_price, 100),
                v_tenant, v_store1, v_purchased_at);

        -- Stock in, and the weighted average the RPC applies: existing stock at
        -- its old cost plus the new units at the price just paid.
        UPDATE public.product_variants v
           SET cost_price_avg = (
                 coalesce((SELECT sum(inv.quantity) FROM public.inventory inv
                            WHERE inv.variant_id = v.id), 0) * coalesce(v.cost_price_avg, 0)
                 + 10 * greatest(v_price, 100)
               ) / (coalesce((SELECT sum(inv.quantity) FROM public.inventory inv
                               WHERE inv.variant_id = v.id), 0) + 10)
         WHERE v.id = v_variant;

        INSERT INTO public.inventory(store_id, variant_id, quantity)
        VALUES (v_store1, v_variant, 10)
        ON CONFLICT (store_id, variant_id)
        DO UPDATE SET quantity = inventory.quantity + excluded.quantity, updated_at = now();
      END LOOP;

      -- Bump request_items to the lines that were written, so the purchase is
      -- not a header with an empty body.
      UPDATE public.purchases p
         SET request_items = coalesce((
               SELECT jsonb_agg(jsonb_build_object('variant_id', pi.variant_id,
                                                   'quantity', pi.quantity,
                                                   'unit_cost', pi.unit_cost))
                 FROM public.purchase_items pi WHERE pi.purchase_id = p.id), '[]'::jsonb)
       WHERE p.id = v_purchase;
    ELSE
      SELECT p.id INTO v_purchase FROM public.purchases p
       WHERE p.request_id = '00000000-0000-4000-8000-0000000a0001'::uuid;
    END IF;

    -- The debt this purchase created, less whatever has been paid since.
    UPDATE public.suppliers
       SET total_debt = greatest(v_total_cost - v_paid, 0)
     WHERE id = v_supplier;

    -- The partial payment, three days ago. request_id has a unique index, so a
    -- fixed uuid keeps a re-run from paying twice.
    IF NOT EXISTS (
      SELECT 1 FROM public.supplier_payments sp
       WHERE sp.request_id = '00000000-0000-4000-8000-0000000a0002'::uuid) THEN
      INSERT INTO public.supplier_payments(store_id, tenant_id, supplier_id, amount,
                                           paid_by, request_id, created_at)
      VALUES (v_store1, v_tenant, v_supplier, v_paid, v_owner,
              '00000000-0000-4000-8000-0000000a0002'::uuid,
              date_trunc('day', now()) - 3 * interval '1 day' + interval '12 hours');
    END IF;
  END;

  -- ============================================================== payroll
  -- One salary run three days ago and two advances today.
  --
  -- engine_pay_salary() adds each payment to shifts.total_employee_payments of
  -- the OPEN shift, which is how engine_close_shift() later subtracts it. A
  -- historical payroll belongs to a shift that is already closed, so its
  -- amount is written into that closed shift's own total — otherwise today's
  -- open drawer would be debited for money paid three days ago.
  DECLARE
    v_pay_shift uuid;
    v_pay_time timestamptz := date_trunc('day', now()) - 3 * interval '1 day' + interval '16 hours';
  BEGIN
    IF v_employee IS NOT NULL THEN
      IF NOT EXISTS (SELECT 1 FROM public.employee_payroll ep
                      WHERE ep.request_id = '00000000-0000-4000-8000-0000000b0001'::uuid) THEN
        INSERT INTO public.employee_payroll(user_id, amount_paid, month, notes, store_id,
                                            request_id, created_at)
        VALUES (v_employee, 30000,
                -- month is validated by the RPC as YYYY-MM; the salary belongs
                -- to the month the payment was made in.
                to_char(v_pay_time, 'YYYY-MM'),
                tag || ' راتب', v_store1,
                '00000000-0000-4000-8000-0000000b0001'::uuid, v_pay_time);

        -- Charge it to the shift that was open when it was paid.
        SELECT s.id INTO v_pay_shift
          FROM public.shifts s
         WHERE s.store_id = v_store1 AND s.status = 'closed'
           AND v_pay_time >= s.start_time AND v_pay_time < coalesce(s.end_time, now())
         ORDER BY s.start_time DESC LIMIT 1;
        IF v_pay_shift IS NOT NULL THEN
          UPDATE public.shifts
             SET total_employee_payments = total_employee_payments + 30000
           WHERE id = v_pay_shift;
        END IF;
      END IF;

      -- Two advances today. They belong to TODAY's open shift, and no closed
      -- shift can include them because the shift below opens after this.
      INSERT INTO public.employee_advances(user_id, amount, reason, store_id, request_id, created_at)
      SELECT v_employee, x.amount, x.reason, v_store1, x.key::uuid, now() - interval '2 hours'
        FROM (VALUES
          (2000, tag || ' سلفة على الراتب', '00000000-0000-4000-8000-0000000b0002'),
          (1000, tag || ' سلفة مصاريف',     '00000000-0000-4000-8000-0000000b0003')
        ) AS x(amount, reason, key)
       WHERE NOT EXISTS (
         SELECT 1 FROM public.employee_advances ea WHERE ea.request_id = x.key::uuid);
    END IF;
  END;

  -- ============================================================ today's sales
  -- Three invoices today: two cash, one credit for يوسف بن علي with 5 000 left.
  -- These land at +8…+13h *before* the open shift is created, so the open
  -- shift's window starts after them — the same rule as everywhere else, and
  -- the reason the shift is inserted last.
  FOR i IN 1 .. 3 LOOP
    CONTINUE WHEN EXISTS (
      SELECT 1 FROM public.sales x WHERE x.store_id = v_store1
         AND x.local_id = 'hist:today:' || i);

    SELECT p.id, pv.id, p.base_price, coalesce(pv.cost_price_avg, 0)
      INTO v_product, v_variant, v_price, v_cost
      FROM public.products p
      JOIN public.product_variants pv ON pv.product_id = p.id
     WHERE p.tenant_id = v_tenant AND p.is_active
     ORDER BY p.name, pv.size
     OFFSET (i * 7) LIMIT 1;
    CONTINUE WHEN v_variant IS NULL;

    v_qty   := 1 + (i % 2);
    v_total := v_price * v_qty;
    v_today_total := v_today_total + v_total;

    INSERT INTO public.sales(store_id, user_id, total_amount, cash_amount,
                             payment_method, status, local_id, synced_at, created_at)
    VALUES (v_store1, v_owner, v_total,
            -- The credit invoice takes no cash today.
            CASE WHEN i = 3 THEN 0 ELSE v_total END,
            CASE WHEN i = 3 THEN 'credit' ELSE 'cash' END,
            'completed', 'hist:today:' || i,
            -- Running the seed at 08:00 must not date a sale at 15:00. The
            -- intended hour is +8…+10h, clamped to "not later than now" so a
            -- morning run cannot create a future invoice.
            least(now(), date_trunc('day', now()) + (7 + i) * interval '1 hour'),
            least(now(), date_trunc('day', now()) + (7 + i) * interval '1 hour'))
    RETURNING id INTO v_sale;

    INSERT INTO public.sale_items(sale_id, variant_id, quantity, original_price,
                                  final_price, unit_price, subtotal, cost_at_sale)
    VALUES (v_sale, v_variant, v_qty, v_price, v_price, v_price, v_total, v_cost);

    UPDATE public.inventory
       SET quantity = greatest(quantity - v_qty, 0), updated_at = now()
     WHERE variant_id = v_variant AND store_id = v_store1;
  END LOOP;

  -- يوسف بن علي's debt for today's credit invoice, with 5 000 still owed.
  SELECT c.id INTO v_customer_id
    FROM public.customers c WHERE c.tenant_id = v_tenant AND c.phone = '0660101005';

  IF v_customer_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.credits cr
     WHERE cr.store_id = v_store1 AND cr.customer_id = v_customer_id
       AND cr.description LIKE tag || '%') THEN
    -- Attached to today's credit sale so the invoice and the debt agree.
    INSERT INTO public.credits(store_id, created_by, customer_id, total_amount,
                               remaining_amount, due_date, status, description,
                               sale_id, created_at)
    VALUES (v_store1, v_owner, v_customer_id, 12000, 5000,
            (now() + interval '30 days')::date, 'active',
            tag || ' دين اليوم — يوسف بن علي',
            (SELECT id FROM public.sales WHERE store_id = v_store1
              AND local_id = 'hist:today:3'),
            now() - interval '1 hour')
    RETURNING id INTO v_credit;

    -- The part he paid at the counter.
    INSERT INTO public.credit_payments(credit_id, amount, paid_at, created_by,
                                       store_id, payment_method, created_at)
    VALUES (v_credit, 7000, now() - interval '1 hour',
            v_owner, v_store1, 'cash', now() - interval '1 hour');
  END IF;

  -- ======================================================== today's expenses
  -- Exactly the three the brief names. Dated a couple of hours ago so they sit
  -- in today's reports and before today's shift opens.
  INSERT INTO public.expenses(store_id, amount, description, category, receipt_url,
                              created_by, status, request_id, created_at)
  SELECT v_store1, x.amount, x.description, x.category,
         'https://example.com/seed-receipt.jpg', v_owner, 'approved',
         x.key::uuid, now() - x.hours * interval '1 hour'
    FROM (VALUES
      (1500, tag || ' كهرباء',  'كهرباء وماء', '00000000-0000-4000-8000-0000000c0001', 3),
      ( 500, tag || ' تغليف',   'أخرى',        '00000000-0000-4000-8000-0000000c0002', 2),
      ( 800, tag || ' نقل',     'نقل',         '00000000-0000-4000-8000-0000000c0003', 1)
    ) AS x(amount, description, category, key, hours)
   WHERE NOT EXISTS (
     SELECT 1 FROM public.expenses e WHERE e.request_id = x.key::uuid);

  -- ========================================================== today's shift
  -- Inserted last on purpose: every sale above is already written, so shifting
  -- the window by [now(), infinity) can never capture a row from a previous
  -- day, and a re-run cannot duplicate the open shift (one open per store is a
  -- unique index).
  --
  -- The opening float is 15 000 for today against 10 000 on the closed days.
  IF NOT EXISTS (
    SELECT 1 FROM public.shifts s
     WHERE s.store_id = v_store1 AND s.status = 'open') THEN

    -- 15 000: a slightly heavier float than the 10 000 the week opened with,
    -- which is what a shop would start a busy day with.
    v_opening := 15000;

    INSERT INTO public.shifts(store_id, user_id, status, start_time, expected_cash,
                              actual_cash, difference, total_cash_sales,
                              total_employee_payments, notes)
    VALUES (v_store1, v_owner, 'open', now(),
            v_opening, 0, 0, 0,
            -- The two advances above were paid from this drawer.
            3000,
            tag || ' وردية اليوم — الرصيد الافتتاحي ' || v_opening)
    RETURNING id INTO v_shift;
  END IF;

  -- Today's day_closes row is deliberately NOT written: the day is still open.
  -- A close row for an open day would make the daily-close screen show a
  -- completed reconciliation that has not happened.

  RAISE NOTICE 'seed_history: 6 ورديات مغلقة + وردية اليوم، 6 تقفيلات، 25 فاتورة، 5 ديون، مصاريف ومشتريات ورواتب';
END
$hist$;
