-- ============================================================================
-- seed_data.sql — realistic demo data for ONE existing tenant
--
-- Run by hand in the Supabase SQL editor. This is NOT a migration: nothing
-- depends on it, so it is safe to keep out of the numbered sequence.
--
-- ── Idempotency ─────────────────────────────────────────────────────────────
-- Every row it creates carries a marker: names start with `[seed]`, customer
-- phones come from a reserved block (05/06/07 010000x), and every generated
-- sale / expense / purchase uses a `seed:…` request id. A second run finds its
-- own work and skips it. Nothing is ever truncated or deleted.
--
-- ── What it deliberately does NOT do ────────────────────────────────────────
-- It will not invent a shift, a drawer balance, or a cash movement.
--
--   * Seeded sales are historical and already `completed` + synced. A sale paid by cash
--     carries `cash_amount = 0` so it can never be mistaken for money in a
--     drawer: a demo must not make a real close-shift reconciliation wrong.
--   * Because of that, seeded sales do NOT appear in today's dashboard KPIs —
--     those read today's rows. They do appear in reports, ledgers, product
--     cost history and the storefront.
--
-- ── Warnings ────────────────────────────────────────────────────────────────
--   * It picks the tenant with the most stores. Change `tenant_override` below
--     to target a specific one.
--   * It adds 2 stores, 15 products and 10 sales to that tenant. On a live
--     shop those are fake sales in real reports. Use a demo tenant.
--   * It raises if the tenant has no owner/manager, because sales and expenses
--     need a `created_by`.
--
-- Requires 202611120012 or later. Idempotent. Safe to re-run.
-- ============================================================================

DO $seed$
DECLARE
  tag constant text := '[seed]';
  -- NULL = pick the tenant with the most stores.
  tenant_override constant uuid := NULL;

  v_tenant uuid; v_owner uuid;
  v_store1 uuid; v_store2 uuid; v_store3 uuid;
  v_supplier1 uuid; v_supplier2 uuid; v_supplier3 uuid;
  v_product uuid; v_variant uuid;
  v_customer record;
  v_sale uuid; v_shift uuid; v_purchase uuid; v_qty integer;
  v_supplier_store_id boolean;
  -- Blocks added later in this file. Kept separate from the variables above so
  -- an existing name can never be silently reused for a different purpose.
  v_order uuid; v_credit record; v_customer_id uuid;
  v_yesterday date; v_opening integer; v_expected integer; v_actual integer;
  v_spent integer;
  -- Order/alert blocks use their own columns rather than borrowing v_name,
  -- v_size and v_color, which already mean "product name / variant size /
  -- variant colour" in the product loop above.
  v_order_number text; v_order_status text; v_phone text;
  v_prod_name text; v_prod_size text; v_prod_color text;
  i integer; j integer;
  v_size text; v_color text; v_cost integer; v_price integer;
  v_name text; v_size_list text[];
  v_day integer;
  v_cash integer; v_total integer;

  -- name, category, subcategory, price, cost, sizes
  -- One row per product, as parallel flat arrays. A nested `text[][]` literal
  -- makes Postgres infer the element type from the first row's mix of text and
  -- integers and fail with "invalid input syntax for type integer". Every
  -- price and cost below is an unquoted integer.
  p_name   constant text[]    := ARRAY[
    'قميص كتان صيفي',
    'تيشيرت قطن بيومي',
    'جينز مستقيم كلاسيك',
    'فستان مبطن للصيف',
    'سترة خفيفة للمساء',
    'حذاء رياضي أبيض',
    'حذاء جلد كلاسيك',
    'صندل جلد صيفي',
    'شبشب منزلي قطني',
    'حزام جلد طبيعي',
    'محفظة جلد صغيرة',
    'نظارة شمسية مربعة',
    'حقيبة كتف متوسطة',
    'طاقية صيفية قطنية',
    'وشاح حريري مطبوع'
  ];
  p_cat    constant text[]    := ARRAY[
    'ملابس',
    'ملابس',
    'ملابس',
    'ملابس',
    'ملابس',
    'أحذية',
    'أحذية',
    'أحذية',
    'أحذية',
    'إكسسوار',
    'إكسسوار',
    'إكسسوار',
    'إكسسوار',
    'إكسسوار',
    'إكسسوار'
  ];
  p_subcat constant text[]    := ARRAY[
    'قمصان',
    'تيشيرت',
    'بناطيل',
    'فساتين',
    'جاكيتات',
    'رياضية',
    'كلاسيك',
    'صنادل',
    'منزلي',
    'أحزمة',
    'محافظ',
    'نظارات',
    'حقائب',
    'قبعات',
    'أوشحة'
  ];
  p_price  constant integer[] := ARRAY[
    4200,
    1900,
    5600,
    6500,
    8200,
    7400,
    9800,
    3900,
    1500,
    2200,
    3100,
    3600,
    5900,
    1200,
    2700
  ];
  p_cost   constant integer[] := ARRAY[
    2400,
    1000,
    3200,
    3800,
    5000,
    4300,
    6100,
    2100,
    700,
    1100,
    1700,
    1800,
    3400,
    550,
    1300
  ];
  p_sizes  constant text[]    := ARRAY[
    'S,M,L,XL',
    'S,M,L,XL',
    '38,40,42,44',
    'S,M,L',
    'M,L,XL',
    '40,41,42,43,44',
    '40,41,42,43',
    '39,40,41,42',
    '40,41,42,43',
    '85,90,95',
    'مقاس واحد',
    'مقاس واحد',
    'مقاس واحد',
    'مقاس واحد',
    'مقاس واحد'
  ];
  colors constant text[] := ARRAY['أسود', 'أبيض', 'كحلي', 'بيج', 'أحمر'];

BEGIN
  -- ============================================================ the tenant
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

  RAISE NOTICE 'seed_data: المؤسسة % (المستخدم %)', v_tenant, v_owner;

  -- ================================================================ stores
  SELECT s.id INTO v_store1
    FROM public.stores s WHERE s.tenant_id = v_tenant
   ORDER BY s.created_at NULLS LAST, s.id LIMIT 1;

  IF NOT EXISTS (SELECT 1 FROM public.stores WHERE tenant_id = v_tenant AND name = tag || ' فرع 2 · باب الزوار') THEN
    INSERT INTO public.stores(tenant_id, name, address, phone, slug, store_enabled, show_prices)
    VALUES (v_tenant, tag || ' فرع 2 · باب الزوار', 'باب الزوار، الجزائر العاصمة',
            '0550100102', 'seed-branch-2', true, true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.stores WHERE tenant_id = v_tenant AND name = tag || ' فرع 3 · قسنطينة') THEN
    INSERT INTO public.stores(tenant_id, name, address, phone, slug, store_enabled, show_prices)
    VALUES (v_tenant, tag || ' فرع 3 · قسنطينة', 'وسط مدينة قسنطينة',
            '0550100103', 'seed-branch-3', true, true);
  END IF;
  SELECT id INTO v_store2 FROM public.stores WHERE tenant_id = v_tenant AND name = tag || ' فرع 2 · باب الزوار';
  SELECT id INTO v_store3 FROM public.stores WHERE tenant_id = v_tenant AND name = tag || ' فرع 3 · قسنطينة';

  -- ============================================================= suppliers
  -- Direct INSERT, not engine_add_supplier(). The RPC ends in engine_staff(),
  -- which reads public.current_staff() — a lookup keyed on auth.uid(). This
  -- script runs in the SQL Editor as `postgres` with no JWT, so current_staff()
  -- returns nothing and the RPC raises before it writes:
  --     ERROR: P0001: غير مصرح لك بإدارة الموردين والمشتريات في هذا المتجر
  -- Seeding is an owner-level operation performed by whoever holds the database
  -- password, so it writes the rows itself. The same applies to every other RPC
  -- below: all of them are SECURITY DEFINER with a current_staff() guard.
  -- suppliers.store_id is ambiguous across sources, so it is not guessed.
  -- Migration 002 adds it and the read policy filters on it; one schema
  -- summary says the live table has no such column. Inserting a column that
  -- is absent fails outright, so existence is checked first: with the column,
  -- the row is scoped to the branch (matching engine_add_supplier); without
  -- it, the row is inserted tenant-wide, which the owner policy still permits.
  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'suppliers' AND column_name = 'store_id'
  ) INTO v_supplier_store_id;

  IF v_supplier_store_id THEN
    EXECUTE $sql$
      INSERT INTO public.suppliers(store_id, tenant_id, name, phone, supplied_goods, total_debt)
      SELECT $1, $2, x.name, x.phone, x.goods, 0
        FROM (VALUES
          ($3, '0550100201', 'قمصان، فساتين، أقمشة'),
          ($4, '0660100202', 'أحذية رياضية وكلاسيكية'),
          ($5, '0770100203', 'أحزمة، محافظ، نظارات')
        ) AS x(name, phone, goods)
       WHERE NOT EXISTS (
         SELECT 1 FROM public.suppliers sp WHERE sp.tenant_id = $2 AND sp.name = x.name)
    $sql$ USING v_store1, v_tenant,
      tag || ' مورد الأقمشة', tag || ' مورد الأحذية', tag || ' مورد الإكسسوار';
  ELSE
    EXECUTE $sql$
      INSERT INTO public.suppliers(tenant_id, name, phone, supplied_goods, total_debt)
      SELECT $1, x.name, x.phone, x.goods, 0
        FROM (VALUES
          ($2, '0550100201', 'قمصان، فساتين، أقمشة'),
          ($3, '0660100202', 'أحذية رياضية وكلاسيكية'),
          ($4, '0770100203', 'أحزمة، محافظ، نظارات')
        ) AS x(name, phone, goods)
       WHERE NOT EXISTS (
         SELECT 1 FROM public.suppliers sp WHERE sp.tenant_id = $1 AND sp.name = x.name)
    $sql$ USING v_tenant,
      tag || ' مورد الأقمشة', tag || ' مورد الأحذية', tag || ' مورد الإكسسوار';
  END IF;
  SELECT id INTO v_supplier1 FROM public.suppliers WHERE tenant_id = v_tenant AND name = tag || ' مورد الأقمشة';
  SELECT id INTO v_supplier2 FROM public.suppliers WHERE tenant_id = v_tenant AND name = tag || ' مورد الأحذية';
  SELECT id INTO v_supplier3 FROM public.suppliers WHERE tenant_id = v_tenant AND name = tag || ' مورد الإكسسوار';

  -- ============================================================== products
  FOR i IN 1 .. array_length(p_name, 1) LOOP
    v_name  := tag || ' ' || p_name[i];
    v_price := p_price[i];
    v_cost  := p_cost[i];
    v_size_list := string_to_array(p_sizes[i], ',');

    SELECT id INTO v_product FROM public.products WHERE tenant_id = v_tenant AND name = v_name;
    IF v_product IS NULL THEN
      -- `price` is NOT NULL and defaults to 0. It is not read by the app (which
      -- uses base_price), but leaving it at 0 would put a wrong number in a
      -- column the schema treats as the product's price, so it is set properly.
      INSERT INTO public.products(tenant_id, name, description, category, subcategory,
                                  base_price, price, type, images, image_url, is_active)
      VALUES (v_tenant, v_name,
              'قطعة موسمية متوفرة بعدة مقاسات.',
              p_cat[i], p_subcat[i], v_price, v_price, 'variable',
              ARRAY['https://picsum.photos/seed/vetrina-' || i || '/800/1000'],
              'https://picsum.photos/seed/vetrina-' || i || '/800/1000',
              true)
      RETURNING id INTO v_product;
    END IF;

    FOR j IN 1 .. array_length(v_size_list, 1) LOOP
      v_size  := btrim(v_size_list[j]);
      v_color := colors[1 + ((i + j) % array_length(colors, 1))];

      SELECT id INTO v_variant FROM public.product_variants
       WHERE product_id = v_product AND size = v_size AND coalesce(color, '') = v_color;

      IF v_variant IS NULL THEN
        INSERT INTO public.product_variants(product_id, barcode, color, size, sku,
                                            cost_price_avg, min_price)
        VALUES (v_product, 'SEED' || lpad(((i * 100) + j)::text, 8, '0'),
                v_color, v_size, 'SEED-' || i || '-' || j,
                v_cost,
                -- The POS refuses a sale below min_price; seeding it at cost
                -- keeps the floor honest instead of blocking every demo sale.
                greatest(v_cost, 0))
        RETURNING id INTO v_variant;
      END IF;

      -- Stock in all three branches, varied so low-stock alerts are realistic.
      INSERT INTO public.inventory(store_id, variant_id, quantity)
      VALUES (v_store1, v_variant, 12 + ((i + j) % 8)) ON CONFLICT (store_id, variant_id) DO NOTHING;
      INSERT INTO public.inventory(store_id, variant_id, quantity)
      VALUES (v_store2, v_variant, 6 + ((i * j) % 6)) ON CONFLICT (store_id, variant_id) DO NOTHING;
      INSERT INTO public.inventory(store_id, variant_id, quantity)
      VALUES (v_store3, v_variant, 3 + ((i + j * 2) % 5)) ON CONFLICT (store_id, variant_id) DO NOTHING;
    END LOOP;
  END LOOP;

  RAISE NOTICE 'seed_data: % منتجاً مع مقاساتها ومخزونها', array_length(p_name, 1);

  -- ============================================================= customers
  -- The unique index on (tenant_id, match_key) already prevents duplicates,
  -- but the explicit check makes a re-run a no-op rather than an error.
  INSERT INTO public.customers(tenant_id, name, phone)
  SELECT v_tenant, x.name, x.phone
    FROM (VALUES
      (tag || ' أمين بن عيسى',     '0550100001'),
      (tag || ' سارة حمداوي',      '0660100002'),
      (tag || ' ياسين بوزيد',      '0770100003'),
      (tag || ' نهاد مرابط',       '0550100004'),
      (tag || ' عبد الرحمن قاسمي', '0660100005')
    ) AS x(name, phone)
   WHERE NOT EXISTS (SELECT 1 FROM public.customers c WHERE c.tenant_id = v_tenant AND c.phone = x.phone);

  -- ================================================================ offers
  -- Two products on "2 for 3000", the classic Algerian shop promotion.
  --
  -- Direct INSERT for the same auth reason as the suppliers. Note `variant_id`
  -- is NULL on purpose: since 202611120004 an offer belongs to a product, so a
  -- bundle counts one medium and one large of the same shirt as two shirts.
  -- discount_percentage is NULL for a bundle; that NULL is what engine_offers
  -- reads to report the offer back as kind = 'bundle'.
  FOR i IN 1 .. 2 LOOP
    v_name := tag || ' ' || p_name[i];
    SELECT id INTO v_product FROM public.products WHERE tenant_id = v_tenant AND name = v_name;
    IF v_product IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM public.offers o
       WHERE o.tenant_id = v_tenant AND o.product_id = v_product AND o.variant_id IS NULL
    ) THEN
      INSERT INTO public.offers(tenant_id, product_id, variant_id, discount_percentage,
                                required_qty, offer_price, name, is_active)
      VALUES (v_tenant, v_product, NULL, NULL, 2, 3000, tag || ' عرض 2 بـ 3000', true);
    END IF;
  END LOOP;

  -- ================================================================ sales
  -- 10 historical invoices across the last 7 days, two per branch pattern.
  -- `synced_at` + a `seed:` local_id keep them out of the outbox entirely, and
  -- cash_amount is zero unless the customer actually paid cash — the drawer
  -- maths must never see a number this script invented.
  FOR v_day IN 1 .. 10 LOOP
    IF EXISTS (SELECT 1 FROM public.sales WHERE local_id = 'seed:sale:' || v_day) THEN
      CONTINUE;
    END IF;

    v_product := NULL;
    SELECT p.id, v.id INTO v_product, v_variant
      FROM public.products p
      JOIN public.product_variants v ON v.product_id = p.id
     WHERE p.tenant_id = v_tenant AND p.name = tag || ' ' || p_name[1 + (v_day % 15)]
     ORDER BY v.size LIMIT 1;
    CONTINUE WHEN v_variant IS NULL;

    v_qty   := 1 + (v_day % 3);
    v_price := (SELECT base_price FROM public.products WHERE id = v_product);
    v_total := v_price * v_qty;

    INSERT INTO public.sales(store_id, user_id, total_amount, cash_amount, payment_method,
                             status, local_id, synced_at, created_at)
    VALUES (CASE v_day % 3 WHEN 0 THEN v_store2 WHEN 1 THEN v_store3 ELSE v_store1 END,
            v_owner, v_total,
            -- Only the card/cash split the till would really have taken.
            CASE WHEN v_day % 3 = 0 THEN 0 ELSE v_total END,
            CASE v_day % 3 WHEN 0 THEN 'credit' ELSE 'cash' END,
            -- 'completed', not 'synced': sales.status is the invoice lifecycle
            -- (completed / cancelled / returned) and nothing more. "Has been
            -- synchronised" is expressed by synced_at being set, below.
            -- Every financial query filters status = 'completed', so any other
            -- value makes the sale invisible to reports, ledgers and payroll.
            'completed', 'seed:sale:' || v_day,
            -- Spread over the past week, never in the future. `v_day` runs
            -- 1..10, so counting back from 10 keeps the newest at yesterday;
            -- normalising to midday stops the +10h crossing midnight.
            date_trunc('day', now()) - (10 - v_day) * interval '1 day' + interval '12 hours',
            date_trunc('day', now()) - (10 - v_day) * interval '1 day' + interval '12 hours')
    RETURNING id INTO v_sale;

    -- cost_at_sale is what the profit report reads: snapshot it, never join
    -- back to a cost that may have changed since.
    INSERT INTO public.sale_items(sale_id, variant_id, quantity, original_price,
                                  final_price, unit_price, subtotal, cost_at_sale)
    SELECT v_sale, v_variant, v_qty, v_price, v_price, v_price, v_total,
           coalesce(pv.cost_price_avg, 0)
      FROM public.product_variants pv WHERE pv.id = v_variant;

    -- Stock moved out; keep the ledger consistent with the invoice.
    UPDATE public.inventory
       SET quantity = greatest(quantity - v_qty, 0), updated_at = now()
     WHERE variant_id = v_variant
       AND store_id = (SELECT store_id FROM public.sales WHERE id = v_sale);
  END LOOP;

  RAISE NOTICE 'seed_data: المبيعات جاهزة';

  -- =============================================================== credits
  -- One open debt per customer, attached to a credit-method sale where the
  -- totals line up, so the ledger and the invoice agree.
  i := 0;
  FOR v_customer IN
    SELECT c.id AS customer_id, c.name AS customer_name FROM public.customers c
     WHERE c.tenant_id = v_tenant AND c.phone LIKE '%01000%'
     ORDER BY c.phone
  LOOP
    i := i + 1;
    v_total := 3000 + i * 1500;

    IF EXISTS (
      SELECT 1 FROM public.credits cr
       WHERE cr.store_id = v_store1 AND cr.customer_id = v_customer.customer_id
    ) THEN CONTINUE; END IF;

    INSERT INTO public.credits(store_id, created_by, customer_id, total_amount,
                               remaining_amount, description, status, created_at)
    VALUES (v_store1, v_owner, v_customer.customer_id, v_total, v_total,
            tag || ' دين سابق', 'active', now() - (i * interval '2 day'))
    RETURNING id INTO v_shift;

    -- A partial payment on two of the five, so the ledger is not all zeros.
    IF i <= 2 THEN
      UPDATE public.credits SET remaining_amount = greatest(v_total - 1000, 0)
       WHERE id = v_shift;
    END IF;
  END LOOP;

  -- ==================================================== pending collections
  -- Cheques that have not cleared. They are paper, not cash: `pending` status
  -- and no shift_id means the drawer never sees them.
  -- receipt_url is NOT NULL on this table (a 23502 proved it), so a placeholder
  -- is supplied rather than NULL. It points at nothing real on purpose: these
  -- are demo cheques, and a fake path in the receipts bucket would look like a
  -- document that exists.
  INSERT INTO public.pending_collections(store_id, customer_name, amount, payment_method,
                                         receipt_url, status, created_at)
  SELECT v_store1, x.customer_name, x.amount, x.method,
         'https://example.com/seed-receipt.jpg', 'pending', now() - interval '3 day'
    FROM (VALUES
      (tag || ' أمين بن عيسى', 5500, 'check'),
      (tag || ' سارة حمداوي',  4200, 'ccp'),
      (tag || ' ياسين بوزيد',  3100, 'check')
    ) AS x(customer_name, amount, method)
   WHERE NOT EXISTS (
     SELECT 1 FROM public.pending_collections pc
      WHERE pc.store_id = v_store1 AND pc.customer_name = x.customer_name);

  -- ============================================================== expenses
  -- Approved, historical, and inside no open shift: they reduce nothing that a
  -- real drawer reconciliation reads.
  -- request_id is a uuid column, so it cannot hold 'seed:expense:elec'. Fixed
  -- uuid keys are used instead: a uuid constant is a constant, so the same key
  -- yields the same id on every run and the re-run check stays idempotent.
  INSERT INTO public.expenses(store_id, amount, description, category, receipt_url,
                              created_by, status, request_id, created_at)
  -- The expense RPC accepts a NULL receipt, but that nullability is not
  -- verified for this table, so a placeholder avoids repeating the 23502 above.
  SELECT v_store1, x.amount, x.description, x.category,
         'https://example.com/seed-receipt.jpg', v_owner, 'approved',
         (x.key)::uuid, now() - x.days * interval '1 day'
    FROM (VALUES
      -- Categories must match CATEGORIES in app/dashboard/_screens/expenses.js,
      -- otherwise the expense screen cannot render or filter them.
      (12000, tag || ' فاتورة كهرباء',  'كهرباء وماء', '00000000-0000-4000-8000-000000000e01', 2),
      (35000, tag || ' إيجار المحل',    'إيجار',       '00000000-0000-4000-8000-000000000e02', 5),
      ( 2400, tag || ' أكياس وتغليف',   'أخرى',        '00000000-0000-4000-8000-000000000e03', 1),
      ( 1800, tag || ' أدوات تنظيف',    'أخرى',        '00000000-0000-4000-8000-000000000e04', 3),
      ( 4500, tag || ' صيانة مكيف',     'صيانة',       '00000000-0000-4000-8000-000000000e05', 6)
    ) AS x(amount, description, category, key, days)
   WHERE NOT EXISTS (
     SELECT 1 FROM public.expenses e WHERE e.request_id = (x.key)::uuid);

  -- ============================================================== purchases
  -- One received purchase from the shoe supplier. Written with direct INSERTs
  -- for the same reason as the suppliers: engine_receive_purchase() also calls
  -- engine_staff(). The RPC's own logic is reproduced here — the purchase row,
  -- its line, the stock increment and the weighted cost average — because
  -- skipping any of them would leave stock and cost disagreeing.
  IF NOT EXISTS (SELECT 1 FROM public.purchases
                  WHERE request_id = '00000000-0000-4000-8000-000000000f01'::uuid) THEN
    SELECT v.id INTO v_variant
      FROM public.products p JOIN public.product_variants v ON v.product_id = p.id
     WHERE p.tenant_id = v_tenant AND p.name = tag || ' ' || p_name[6]
     ORDER BY v.size LIMIT 1;
    IF v_variant IS NOT NULL THEN
      INSERT INTO public.purchases(store_id, tenant_id, supplier_id, supplier_name,
                                   total_amount, status, created_by, request_id,
                                   request_items)
      VALUES (v_store1, v_tenant, v_supplier2, tag || ' مورد الأحذية',
              10 * p_cost[6], 'received', v_owner,
              '00000000-0000-4000-8000-000000000f01'::uuid,
              jsonb_build_array(jsonb_build_object('variant_id', v_variant,
                                                   'quantity', 10, 'unit_cost', p_cost[6])))
      RETURNING id INTO v_purchase;

      INSERT INTO public.purchase_items(purchase_id, variant_id, quantity, unit_cost,
                                        tenant_id, store_id)
      VALUES (v_purchase, v_variant, 10, p_cost[6], v_tenant, v_store1);

      -- Same weighted average the RPC applies: existing stock at its old cost
      -- plus the new units at the price just paid.
      UPDATE public.product_variants v
         SET cost_price_avg = (
               coalesce((SELECT sum(i.quantity) FROM public.inventory i
                          JOIN public.stores s ON s.id = i.store_id
                         WHERE i.variant_id = v.id AND s.tenant_id = v_tenant), 0)
                 * coalesce(v.cost_price_avg, 0) + 10 * p_cost[6]
             ) / (
               coalesce((SELECT sum(i.quantity) FROM public.inventory i
                          JOIN public.stores s ON s.id = i.store_id
                         WHERE i.variant_id = v.id AND s.tenant_id = v_tenant), 0) + 10
             )
       WHERE v.id = v_variant;

      INSERT INTO public.inventory(store_id, variant_id, quantity)
      VALUES (v_store1, v_variant, 10)
      ON CONFLICT (store_id, variant_id)
      DO UPDATE SET quantity = inventory.quantity + excluded.quantity, updated_at = now();

      UPDATE public.suppliers SET total_debt = coalesce(total_debt, 0) + 10 * p_cost[6]
       WHERE id = v_supplier2;
    END IF;
  END IF;


  -- ==================================================== closed shift (demo)
  -- One shift that already happened, yesterday, in the main branch. Until now
  -- the seed created no shift at all, so the closed-shift screen and the daily
  -- cash close had nothing to show.
  --
  -- The figures are derived from rows that exist rather than typed in, the same
  -- way engine_close_shift derives them:
  --   closing = opening float + cash taken - cash paid out
  -- so `difference` is a real reconciliation rather than decoration. Neither
  -- table has an opening-float column, so the float is recorded in `notes`,
  -- which is where a shopkeeper writes it on paper too.
  --
  -- A cash sale is inserted first, inside the shift's window, so the demo shift
  -- has something to reconcile. It is dated yesterday and marked
  -- `seed:shift:1`: no *open* shift can include it, so a real drawer is
  -- unaffected.
  -- LIKE, not =: the note written below appends the opening float, so an
  -- equality check would never match its own row and a re-run would insert a
  -- second shift and then die on the day_closes unique key.
  IF NOT EXISTS (SELECT 1 FROM public.shifts
                  WHERE store_id = v_store1 AND notes LIKE tag || ' وردية الأمس%') THEN
    v_yesterday := (date_trunc('day', now()) - interval '1 day')::date;
    v_opening   := 20000;   -- the opening float

    IF NOT EXISTS (SELECT 1 FROM public.sales WHERE local_id = 'seed:shift:1') THEN
      SELECT p.id, pv.id INTO v_product, v_variant
        FROM public.products p
        JOIN public.product_variants pv ON pv.product_id = p.id
       WHERE p.tenant_id = v_tenant AND p.name = tag || ' ' || p_name[3]
       ORDER BY pv.size LIMIT 1;
      IF v_variant IS NOT NULL THEN
        v_price := (SELECT base_price FROM public.products WHERE id = v_product);
        v_qty   := 2;
        v_total := v_price * v_qty;
        INSERT INTO public.sales(store_id, user_id, total_amount, cash_amount, payment_method,
                                 status, local_id, synced_at, created_at)
        VALUES (v_store1, v_owner, v_total, v_total, 'cash', 'completed', 'seed:shift:1',
                v_yesterday + interval '11 hours', v_yesterday + interval '11 hours')
        RETURNING id INTO v_sale;

        INSERT INTO public.sale_items(sale_id, variant_id, quantity, original_price,
                                      final_price, unit_price, subtotal, cost_at_sale)
        SELECT v_sale, v_variant, v_qty, v_price, v_price, v_price, v_total,
               coalesce(pv.cost_price_avg, 0)
          FROM public.product_variants pv WHERE pv.id = v_variant;

        UPDATE public.inventory
           SET quantity = greatest(quantity - v_qty, 0), updated_at = now()
         WHERE variant_id = v_variant AND store_id = v_store1;
      END IF;
    END IF;

    -- Cash actually taken between those hours.
    SELECT coalesce(sum(x.cash_amount), 0) INTO v_cash
      FROM public.sales x
     WHERE x.store_id = v_store1 AND x.status = 'completed'
       AND x.created_at >= v_yesterday + interval '9 hours'
       AND x.created_at <  v_yesterday + interval '18 hours';

    -- Cash that left the drawer in the same window.
    SELECT coalesce(sum(x.amount), 0) INTO v_spent
      FROM public.expenses x
     WHERE x.store_id = v_store1 AND x.deleted_at IS NULL
       AND x.created_at >= v_yesterday + interval '9 hours'
       AND x.created_at <  v_yesterday + interval '18 hours';

    v_expected := v_opening + v_cash - v_spent;   -- what should be in the drawer
    v_actual   := v_expected - 500;               -- what was counted: 500 short

    INSERT INTO public.shifts(store_id, user_id, status, start_time, end_time,
                              expected_cash, actual_cash, difference,
                              total_cash_sales, notes, closed_at)
    VALUES (v_store1, v_owner, 'closed',
            v_yesterday + interval '9 hours', v_yesterday + interval '18 hours',
            v_expected, v_actual, v_actual - v_expected,
            v_cash, tag || ' وردية الأمس — الرصيد الافتتاحي ' || v_opening,
            v_yesterday + interval '18 hours')
    RETURNING id INTO v_shift;

    -- The daily close that pairs with the shift. Same numbers by construction,
    -- so the two screens cannot tell different stories.
    --
    -- `difference` is deliberately absent here: on this table it is
    -- GENERATED ALWAYS AS (actual_cash - expected_cash) STORED, and Postgres
    -- rejects any value supplied for it with 428C9. Writing the expression out
    -- would fail exactly as it did the first time — the column computes itself.
    --
    -- Note this is NOT true of shifts.difference two blocks up, which is a
    -- plain writable column (it was converted from a generated expression, see
    -- lib/cash.js) and which the POS inserts on every shift open. The two
    -- tables look alike and are not.
    INSERT INTO public.day_closes(store_id, date, expected_cash, actual_cash,
                                  notes, closed_at)
    VALUES (v_store1, v_yesterday, v_expected, v_actual,
            tag || ' تقفيلة الأمس — نقص 500 دج غير مبرر',
            v_yesterday + interval '18 hours');
  END IF;

  -- ================================================== marketplace orders
  -- Three orders in three different states, so the orders screen has one of
  -- each: waiting, confirmed, delivered.
  --
  -- Two constraints are respected literally rather than worked around:
  --   * payment_method has CHECK (payment_method IN ('cod')).
  --   * fulfillment_type has CHECK (... IN ('delivery','pickup')).
  -- `sale_id` stays NULL on the delivered order on purpose: attaching a sale
  -- would move cash and stock that a real drawer reconciliation counts.
  --
  -- Each is picked from parallel flat arrays indexed by i. A nested literal
  -- mixing text and integers makes Postgres infer the element type from the
  -- first row and fail.
  FOR i IN 1 .. 3 LOOP
    v_order_number := (ARRAY['SEED-1001', 'SEED-1002', 'SEED-1003'])[i];
    v_order_status := (ARRAY['new', 'confirmed', 'delivered'])[i];
    v_phone        := (ARRAY['0550100001', '0660100002', '0770100003'])[i];

    CONTINUE WHEN EXISTS (
      SELECT 1 FROM public.orders o
       WHERE o.tenant_id = v_tenant AND o.order_number = v_order_number);

    SELECT c.id INTO v_customer_id
      FROM public.customers c WHERE c.tenant_id = v_tenant AND c.phone = v_phone;
    CONTINUE WHEN v_customer_id IS NULL;

    -- A real product and variant, so each order links to the catalogue instead
    -- of carrying a name invented for the demo.
    SELECT p.id, pv.id, p.name, pv.size, pv.color, p.base_price
      INTO v_product, v_variant, v_prod_name, v_prod_size, v_prod_color, v_price
      FROM public.products p
      JOIN public.product_variants pv ON pv.product_id = p.id
     WHERE p.tenant_id = v_tenant AND p.name = tag || ' ' || p_name[4 + i]
     ORDER BY pv.size LIMIT 1;
    CONTINUE WHEN v_variant IS NULL;

    INSERT INTO public.orders(tenant_id, store_id, customer_id, order_number, status,
                              fulfillment_type, customer_name, customer_phone,
                              wilaya_code, commune, subtotal, delivery_fee, total,
                              payment_method, source, created_at, confirmed_at, delivered_at)
    SELECT v_tenant, v_store1, v_customer_id, v_order_number, v_order_status,
           CASE WHEN i = 3 THEN 'pickup' ELSE 'delivery' END,
           c.name, c.phone,
           (ARRAY['الجزائر', 'قسنطينة', 'وهران'])[i],
           (ARRAY['الجزائر الوسطى', 'الخروب', 'بئر الجير'])[i],
           v_price * i, 0, v_price * i, 'cod', 'web',
           (date_trunc('day', now()) - (3 - i) * interval '1 day') + interval '10 hours',
           CASE WHEN i >= 2 THEN (date_trunc('day', now()) - (3 - i) * interval '1 day') + interval '12 hours' END,
           CASE WHEN i = 3 THEN (date_trunc('day', now()) - (3 - i) * interval '1 day') + interval '16 hours' END
      FROM public.customers c WHERE c.id = v_customer_id
    RETURNING id INTO v_order;

    INSERT INTO public.order_items(order_id, product_id, variant_id, product_name,
                                   size, color, qty, unit_price, line_total)
    VALUES (v_order, v_product, v_variant, v_prod_name, v_prod_size, v_prod_color,
            i, v_price, v_price * i);

    -- The trail an order is expected to have: a 'new' order has one row, a
    -- delivered one has the whole walk.
    INSERT INTO public.order_status_history(order_id, from_status, to_status, changed_by, changed_at)
    VALUES (v_order, NULL, 'new', v_owner,
            (date_trunc('day', now()) - (3 - i) * interval '1 day') + interval '10 hours');
    IF i >= 2 THEN
      INSERT INTO public.order_status_history(order_id, from_status, to_status, changed_by, changed_at)
      VALUES (v_order, 'new', 'confirmed', v_owner,
              (date_trunc('day', now()) - (3 - i) * interval '1 day') + interval '12 hours');
    END IF;
    IF i = 3 THEN
      INSERT INTO public.order_status_history(order_id, from_status, to_status, changed_by, changed_at)
      VALUES (v_order, 'confirmed', 'delivered', v_owner,
              (date_trunc('day', now()) - (3 - i) * interval '1 day') + interval '16 hours');
    END IF;
  END LOOP;

  -- ============================================================== alerts
  -- Four alerts, all describing something genuinely true in this data.
  --
  -- Note what this table does NOT have: no variant_id, product_id or
  -- customer_id column — only store_id, type, message and is_read. A low-stock
  -- alert can therefore only *describe* its variant in the text. The two stock
  -- levels below are really lowered to 2 and 5, so the low-stock bell (which
  -- reads inventory, not this table) agrees with what the alert text says.
  --
  -- `type` has no check constraint, so `low_stock` / `credit_overdue` are the
  -- only spelling they will ever have, and the messages are prefixed with the
  -- seed tag so a re-run recognises its own rows.
  IF NOT EXISTS (SELECT 1 FROM public.alerts
                  WHERE store_id = v_store1 AND message LIKE tag || '%') THEN
    FOR i IN 1 .. 2 LOOP
      SELECT pv.id, p.name, pv.size, pv.color
        INTO v_variant, v_prod_name, v_prod_size, v_prod_color
        FROM public.products p
        JOIN public.product_variants pv ON pv.product_id = p.id
       WHERE p.tenant_id = v_tenant AND p.name = tag || ' ' || p_name[7 + i]
       ORDER BY pv.size LIMIT 1;
      CONTINUE WHEN v_variant IS NULL;

      v_qty := CASE i WHEN 1 THEN 2 ELSE 5 END;

      INSERT INTO public.inventory(store_id, variant_id, quantity)
      VALUES (v_store1, v_variant, v_qty)
      ON CONFLICT (store_id, variant_id)
      DO UPDATE SET quantity = excluded.quantity, updated_at = now();

      INSERT INTO public.alerts(store_id, type, message, is_read, created_at)
      VALUES (v_store1, 'low_stock',
              tag || ' نقص مخزون: ' || v_prod_name || ' — ' || v_prod_size
                    || ' / ' || v_prod_color || ' (المتبقي ' || v_qty || ')',
              false, now() - (i * interval '6 hour'));
    END LOOP;

    -- Two credits that are past due. The due dates are set here rather than
    -- left NULL, so "متأخر" is a fact and not an assertion: the credits screen
    -- shows the date and a reader can check it.
    i := 0;
    FOR v_credit IN
      SELECT cr.id, cr.remaining_amount, c.name
        FROM public.credits cr
        JOIN public.customers c ON c.id = cr.customer_id
       WHERE cr.store_id = v_store1 AND cr.status = 'active'
       ORDER BY cr.created_at
       LIMIT 2
    LOOP
      i := i + 1;
      UPDATE public.credits
         SET due_date = (now() - (i * 5) * interval '1 day')::date
       WHERE id = v_credit.id;

      INSERT INTO public.alerts(store_id, type, message, is_read, created_at)
      VALUES (v_store1, 'credit_overdue',
              tag || ' دين متأخر: ' || v_credit.name || ' — المتبقي '
                    || v_credit.remaining_amount || ' دج، الاستحقاق '
                    || to_char((now() - (i * 5) * interval '1 day')::date, 'YYYY-MM-DD'),
              false, now() - (i * interval '2 hour'));
    END LOOP;
  END IF;

  -- ============================================================ audit log
  -- Five entries of the kind an owner actually audits. The entity ids are
  -- looked up rather than invented, so each entry points at a row that exists;
  -- an audit trail whose subject is missing is worse than none.
  --
  -- audit_log has no tenant_id and no request id, so the re-run check keys on
  -- action + device_info. `device_info` is free text and is exactly what that
  -- field is for; the seed tag there marks these rows as ours.
  INSERT INTO public.audit_log(user_id, action, entity_type, entity_id, details,
                               device_info, store_id, created_at)
  SELECT v_owner, x.action, x.entity_type,
         (CASE x.entity_type
            WHEN 'sale'      THEN (SELECT id FROM public.sales WHERE local_id = 'seed:sale:1')
            WHEN 'expense'   THEN (SELECT id FROM public.expenses
                                    WHERE request_id = '00000000-0000-4000-8000-000000000e02'::uuid)
            WHEN 'credit'    THEN (SELECT id FROM public.credits
                                    WHERE store_id = v_store1 AND status = 'active'
                                    ORDER BY created_at DESC LIMIT 1)
            WHEN 'product'   THEN (SELECT id FROM public.products
                                    WHERE tenant_id = v_tenant AND name = tag || ' ' || p_name[1])
            -- an inventory correction names the store, because a stock level
            -- belongs to a store and not to a variant in the abstract
            ELSE v_store1
          END),
         x.details::jsonb, tag || ' demo', v_store1, now() - x.hours * interval '1 hour'
    FROM (VALUES
      -- A cancelled invoice, with the reason the customer gave.
      ('cancelled_invoice', 'sale',
       '{"reason":"العميل غيّر رأيه","amount":4500}', 30),
      -- A price change: before and after are both recorded, which is the only
      -- thing that makes the entry worth anything later.
      ('price_change', 'product',
       '{"field":"base_price","from":3200,"to":3500}', 26),
      -- Stock corrected by hand after a count.
      ('stock_adjustment', 'inventory',
       '{"reason":"جرد","from":9,"to":2}', 20),
      -- An expense approved.
      ('expense_approved', 'expense',
       '{"amount":35000,"category":"إيجار"}', 14),
      -- An old debt written off.
      ('credit_written_off', 'credit',
       '{"amount":1500,"note":"دين قديم غير قابل للتحصيل"}', 8)
    ) AS x(action, entity_type, details, hours)
   WHERE NOT EXISTS (
     SELECT 1 FROM public.audit_log a
      WHERE a.action = x.action AND a.device_info = tag || ' demo');

  RAISE NOTICE 'seed_data: انتهى. الفروع: % / % / %', v_store1, v_store2, v_store3;
END $seed$;
