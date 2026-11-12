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
--   * Seeded sales are historical and already `synced`. A sale paid by cash
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
  INSERT INTO public.suppliers(store_id, tenant_id, name, phone, supplied_goods, total_debt)
  SELECT v_store1, v_tenant, x.name, x.phone, x.goods, 0
    FROM (VALUES
      (tag || ' مورد الأقمشة',    '0550100201', 'قمصان، فساتين، أقمشة'),
      (tag || ' مورد الأحذية',    '0660100202', 'أحذية رياضية وكلاسيكية'),
      (tag || ' مورد الإكسسوار',  '0770100203', 'أحزمة، محافظ، نظارات')
    ) AS x(name, phone, goods)
   WHERE NOT EXISTS (
     SELECT 1 FROM public.suppliers sp WHERE sp.tenant_id = v_tenant AND sp.name = x.name);
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
      INSERT INTO public.products(tenant_id, name, description, category, subcategory,
                                  base_price, type, images, image_url, is_active)
      VALUES (v_tenant, v_name,
              'قطعة موسمية متوفرة بعدة مقاسات.',
              p_cat[i], p_subcat[i], v_price, 'variable',
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
  -- `synced` + a `seed:` local_id keep them out of the outbox entirely, and
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
            'synced', 'seed:sale:' || v_day,
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
  INSERT INTO public.pending_collections(store_id, customer_name, amount, payment_method,
                                         receipt_url, status, created_at)
  SELECT v_store1, x.customer_name, x.amount, x.method, NULL, 'pending', now() - interval '3 day'
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
  SELECT v_store1, x.amount, x.description, x.category, NULL, v_owner, 'approved',
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

  RAISE NOTICE 'seed_data: انتهى. الفروع: % / % / %', v_store1, v_store2, v_store3;
END $seed$;
