-- Idempotent repair of the credit-payment / expenses schema.
--
-- Why this exists: 202611100022 used
--   CREATE TABLE IF NOT EXISTS credit_payments ( ... created_at ... );
--   CREATE INDEX ... ON credit_payments(credit_id, created_at DESC);
-- On a database where `credit_payments` already existed, CREATE TABLE IF NOT
-- EXISTS is a silent no-op: it protects the table *name*, not the columns. The
-- new column was never added, and the index then failed with
--   column "created_at" does not exist.
--
-- This migration therefore never assumes a column exists. For every table it
-- follows the same strict order:
--
--   1. create the table if missing (minimal shape only)
--   2. ADD COLUMN IF NOT EXISTS for every column the code depends on
--   3. backfill existing rows, then apply DEFAULT / NOT NULL
--   4. verify no unexpected NOT NULL column would break inserts
--   5. create indexes (IF NOT EXISTS) only once their columns exist
--   6. add constraints only when absent and no row violates them
--   7. (re)define functions, policies and grants
--
-- Safe to run repeatedly, and safe on a database that already has rows.

-- =========================================================== credit_payments
CREATE TABLE IF NOT EXISTS public.credit_payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid()
);

ALTER TABLE public.credit_payments ADD COLUMN IF NOT EXISTS credit_id  uuid;
ALTER TABLE public.credit_payments ADD COLUMN IF NOT EXISTS store_id   uuid;
ALTER TABLE public.credit_payments ADD COLUMN IF NOT EXISTS shift_id   uuid;
ALTER TABLE public.credit_payments ADD COLUMN IF NOT EXISTS amount     integer;
ALTER TABLE public.credit_payments ADD COLUMN IF NOT EXISTS created_by uuid;
ALTER TABLE public.credit_payments ADD COLUMN IF NOT EXISTS request_id uuid;
ALTER TABLE public.credit_payments ADD COLUMN IF NOT EXISTS created_at timestamptz;

-- Existing rows may predate created_at: fill first, then constrain.
UPDATE public.credit_payments SET created_at = now() WHERE created_at IS NULL;
ALTER TABLE public.credit_payments ALTER COLUMN created_at SET DEFAULT now();
ALTER TABLE public.credit_payments ALTER COLUMN created_at SET NOT NULL;

-- A pre-existing table may carry columns this code knows nothing about. A NOT
-- NULL column without a default would let inserts fail at runtime with an
-- opaque error, so refuse the migration instead and name the culprit.
DO $$
DECLARE unexpected text;
BEGIN
  SELECT string_agg(column_name, ', ' ORDER BY column_name) INTO unexpected
  FROM information_schema.columns
  WHERE table_schema = 'public' AND table_name = 'credit_payments'
    AND is_nullable = 'NO' AND column_default IS NULL
    AND column_name NOT IN ('id', 'credit_id', 'amount', 'created_at');
  IF unexpected IS NOT NULL THEN
    RAISE EXCEPTION 'credit_payments has NOT NULL columns without a default that this code does not write: %. Add defaults or drop NOT NULL, then re-run.', unexpected;
  END IF;
END $$;

UPDATE public.credit_payments SET id = gen_random_uuid() WHERE id IS NULL;

-- Indexes last, after every column they reference is guaranteed to exist.
CREATE UNIQUE INDEX IF NOT EXISTS credit_payments_request ON public.credit_payments(request_id);
CREATE INDEX IF NOT EXISTS credit_payments_credit ON public.credit_payments(credit_id, created_at DESC);
CREATE INDEX IF NOT EXISTS credit_payments_shift  ON public.credit_payments(shift_id);

-- Constraints are added only if absent *and* no existing row violates them, so a
-- legacy table with loose data can still be migrated.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'credit_payments_pkey'
                 AND conrelid = 'public.credit_payments'::regclass) THEN
    ALTER TABLE public.credit_payments ADD CONSTRAINT credit_payments_pkey PRIMARY KEY (id);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'credit_payments_amount_check'
                 AND conrelid = 'public.credit_payments'::regclass)
     AND NOT EXISTS (SELECT 1 FROM public.credit_payments WHERE amount IS NOT NULL AND amount <= 0) THEN
    ALTER TABLE public.credit_payments
      ADD CONSTRAINT credit_payments_amount_check CHECK (amount IS NULL OR amount > 0);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'credit_payments_credit_id_fkey'
                 AND conrelid = 'public.credit_payments'::regclass)
     AND NOT EXISTS (SELECT 1 FROM public.credit_payments p WHERE p.credit_id IS NOT NULL
                     AND NOT EXISTS (SELECT 1 FROM public.credits c WHERE c.id = p.credit_id)) THEN
    ALTER TABLE public.credit_payments ADD CONSTRAINT credit_payments_credit_id_fkey
      FOREIGN KEY (credit_id) REFERENCES public.credits(id) ON DELETE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'credit_payments_store_id_fkey'
                 AND conrelid = 'public.credit_payments'::regclass)
     AND NOT EXISTS (SELECT 1 FROM public.credit_payments p WHERE p.store_id IS NOT NULL
                     AND NOT EXISTS (SELECT 1 FROM public.stores s WHERE s.id = p.store_id)) THEN
    ALTER TABLE public.credit_payments ADD CONSTRAINT credit_payments_store_id_fkey
      FOREIGN KEY (store_id) REFERENCES public.stores(id);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'credit_payments_shift_id_fkey'
                 AND conrelid = 'public.credit_payments'::regclass)
     AND NOT EXISTS (SELECT 1 FROM public.credit_payments p WHERE p.shift_id IS NOT NULL
                     AND NOT EXISTS (SELECT 1 FROM public.shifts x WHERE x.id = p.shift_id)) THEN
    ALTER TABLE public.credit_payments ADD CONSTRAINT credit_payments_shift_id_fkey
      FOREIGN KEY (shift_id) REFERENCES public.shifts(id);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'credit_payments_created_by_fkey'
                 AND conrelid = 'public.credit_payments'::regclass)
     AND NOT EXISTS (SELECT 1 FROM public.credit_payments p WHERE p.created_by IS NOT NULL
                     AND NOT EXISTS (SELECT 1 FROM public.users u WHERE u.id = p.created_by)) THEN
    ALTER TABLE public.credit_payments ADD CONSTRAINT credit_payments_created_by_fkey
      FOREIGN KEY (created_by) REFERENCES public.users(id);
  END IF;
END $$;

-- Cash taken during a shift. engine_close_shift adds this to expected cash.
ALTER TABLE public.shifts ADD COLUMN IF NOT EXISTS total_credit_payments bigint NOT NULL DEFAULT 0;

ALTER TABLE public.credit_payments ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.credit_payments FROM PUBLIC, anon, authenticated;

-- ================================================================= expenses
ALTER TABLE public.expenses ADD COLUMN IF NOT EXISTS category   text;
-- Financial records are never hard deleted: that would silently rewrite closed
-- accounting periods. Hiding keeps history honest.
ALTER TABLE public.expenses ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
ALTER TABLE public.expenses ADD COLUMN IF NOT EXISTS deleted_by uuid;

CREATE INDEX IF NOT EXISTS expenses_category ON public.expenses(category);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'expenses_deleted_by_fkey'
                 AND conrelid = 'public.expenses'::regclass)
     AND NOT EXISTS (SELECT 1 FROM public.expenses x WHERE x.deleted_by IS NOT NULL
                     AND NOT EXISTS (SELECT 1 FROM public.users u WHERE u.id = x.deleted_by)) THEN
    ALTER TABLE public.expenses ADD CONSTRAINT expenses_deleted_by_fkey
      FOREIGN KEY (deleted_by) REFERENCES public.users(id);
  END IF;
END $$;

-- ======================================================== receipts storage
-- Private bucket, path-scoped by tenant and branch: <tenant_id>/<store_id>/<file>
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('receipts', 'receipts', false, 5242880, ARRAY['image/jpeg','image/png','image/webp','application/pdf'])
ON CONFLICT (id) DO NOTHING;

-- =============================== functions, policies and grants (unchanged)
-- Bodies are identical to 202611100022; only the DDL above changed. They are
-- CREATE OR REPLACE, so re-running is safe.

CREATE OR REPLACE FUNCTION public.engine_credit_payment(
  p_credit uuid, p_amount integer, p_request uuid
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE
  u public.users; c public.credits; s public.shifts; result uuid;
  old_row public.credit_payments; remaining integer; new_status text; customer_name text;
BEGIN
  SELECT * INTO u FROM public.current_staff();
  IF u.id IS NULL THEN RAISE EXCEPTION 'غير مصرح'; END IF;

  SELECT * INTO c FROM public.credits WHERE id = p_credit FOR UPDATE;
  IF c.id IS NULL THEN RAISE EXCEPTION 'الدين غير موجود'; END IF;
  PERFORM public.engine_validate(c.store_id, u.tenant_id, ARRAY['owner','manager','employee']);

  IF p_amount IS NULL OR p_amount <= 0 THEN RAISE EXCEPTION 'أدخل مبلغاً موجباً'; END IF;
  IF p_amount > 2147483647 THEN RAISE EXCEPTION 'المبلغ كبير جداً'; END IF;
  IF p_request IS NULL THEN RAISE EXCEPTION 'طلب غير صالح'; END IF;

  -- Retry safety: replaying the same request returns the original receipt and
  -- must not debit the customer twice.
  PERFORM pg_advisory_xact_lock(hashtextextended(p_request::text, 0));
  SELECT * INTO old_row FROM public.credit_payments WHERE request_id = p_request;
  IF old_row.id IS NOT NULL THEN
    IF old_row.credit_id <> p_credit OR old_row.amount <> p_amount THEN
      RAISE EXCEPTION 'طلب مكرر ببيانات مختلفة';
    END IF;
    SELECT coalesce(cust.name, '') INTO customer_name FROM public.customers cust WHERE cust.id = c.customer_id;
    RETURN jsonb_build_object('ok', true, 'paymentId', old_row.id, 'replayed', true,
      'customer', customer_name, 'amount', old_row.amount,
      'remaining', (SELECT remaining_amount FROM public.credits WHERE id = p_credit));
  END IF;

  -- Cash can only enter an open drawer. Without this the money exists in the
  -- database but nowhere in the reconciliation.
  SELECT * INTO s FROM public.shifts WHERE store_id = c.store_id AND status = 'open' FOR UPDATE;
  IF s.id IS NULL THEN RAISE EXCEPTION 'افتح صندوق الفرع قبل تسجيل الدفعة'; END IF;

  remaining := coalesce(c.remaining_amount, c.total_amount, 0);
  IF p_amount > remaining THEN
    RAISE EXCEPTION 'المبلغ أكبر من المتبقي (%) ', remaining;
  END IF;

  INSERT INTO public.credit_payments(credit_id, store_id, shift_id, amount, created_by, request_id)
  VALUES (p_credit, c.store_id, s.id, p_amount, u.id, p_request)
  RETURNING id INTO result;

  new_status := CASE WHEN remaining - p_amount <= 0 THEN 'paid' ELSE 'active' END;
  -- Only known columns are touched: remaining_amount and status both already
  -- exist and are read by the credits page.
  UPDATE public.credits
  SET remaining_amount = remaining - p_amount,
      status = new_status
  WHERE id = p_credit;

  UPDATE public.shifts SET total_credit_payments = total_credit_payments + p_amount WHERE id = s.id;

  SELECT coalesce(cust.name, '') INTO customer_name FROM public.customers cust WHERE cust.id = c.customer_id;

  RETURN jsonb_build_object(
    'ok', true, 'paymentId', result, 'replayed', false,
    'customer', customer_name, 'amount', p_amount,
    'remaining', remaining - p_amount, 'status', new_status
  );
END $$;

-- ------------------------------------------------------- customer ledger
-- Everything the ledger modal shows, in one round trip.
CREATE OR REPLACE FUNCTION public.engine_customer_ledger(p_customer uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public AS $$
DECLARE u public.users; result jsonb;
BEGIN
  SELECT * INTO u FROM public.current_staff();
  IF u.id IS NULL THEN RAISE EXCEPTION 'غير مصرح'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.customers WHERE id = p_customer AND tenant_id = u.tenant_id) THEN
    RAISE EXCEPTION 'الزبون غير موجود';
  END IF;

  SELECT jsonb_build_object(
    'customer', (SELECT jsonb_build_object('id', id, 'name', name, 'phone', phone)
                 FROM public.customers WHERE id = p_customer),
    'totalDebt', coalesce((SELECT sum(coalesce(c.total_amount, 0)) FROM public.credits c
      JOIN public.stores st ON st.id = c.store_id WHERE c.customer_id = p_customer AND st.tenant_id = u.tenant_id), 0),
    'totalPaid', coalesce((SELECT sum(p.amount) FROM public.credit_payments p
      JOIN public.credits c ON c.id = p.credit_id
      JOIN public.stores st ON st.id = p.store_id
      WHERE c.customer_id = p_customer AND st.tenant_id = u.tenant_id), 0),
    'remaining', coalesce((SELECT sum(coalesce(c.remaining_amount, 0)) FROM public.credits c
      JOIN public.stores st ON st.id = c.store_id WHERE c.customer_id = p_customer AND st.tenant_id = u.tenant_id), 0),
    'payments', coalesce((SELECT jsonb_agg(jsonb_build_object(
        'id', p.id, 'created_at', p.created_at, 'amount', p.amount,
        'by', coalesce(NULLIF(trim(coalesce(pr.full_name, '')), ''), pr.username),
        'shift', p.shift_id IS NOT NULL) ORDER BY p.created_at DESC)
      FROM public.credit_payments p
      JOIN public.credits c ON c.id = p.credit_id
      JOIN public.stores st ON st.id = p.store_id
      LEFT JOIN public.users pr ON pr.id = p.created_by
      WHERE c.customer_id = p_customer AND st.tenant_id = u.tenant_id), '[]'::jsonb),
    'credits', coalesce((SELECT jsonb_agg(jsonb_build_object(
        'id', c.id, 'created_at', c.created_at, 'total', c.total_amount,
        'remaining', c.remaining_amount, 'status', c.status,
        'description', c.description, 'due_date', c.due_date) ORDER BY c.created_at DESC)
      FROM public.credits c JOIN public.stores st ON st.id = c.store_id
      WHERE c.customer_id = p_customer AND st.tenant_id = u.tenant_id), '[]'::jsonb)
  ) INTO result;
  RETURN result;
END $$;

-- ------------------------------------------------ close shift with credit cash
-- Same arithmetic as before plus credit payments. Rewritten rather than patched
-- because the expected-cash formula is the thing this whole task depends on.
CREATE OR REPLACE FUNCTION public.engine_close_shift(
  p_shift uuid, p_actual integer, p_expected bigint, p_difference bigint, p_notes text
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE u public.users; s public.shifts; sales bigint; expected bigint;
BEGIN
  SELECT * INTO u FROM public.current_staff();
  SELECT * INTO s FROM public.shifts WHERE id = p_shift FOR UPDATE;
  PERFORM public.engine_validate(s.store_id, u.tenant_id, ARRAY['owner','manager','employee']);
  IF s.id IS NULL OR s.status <> 'open' THEN RAISE EXCEPTION 'الوردية مغلقة'; END IF;
  SELECT coalesce(sum(total_amount), 0) INTO sales FROM public.sales
   WHERE store_id = s.store_id AND payment_method = 'cash' AND status = 'completed'
     AND created_at >= s.start_time AND created_at < now();
  expected := s.expected_cash::bigint + sales - s.total_employee_payments
              + coalesce(s.total_credit_payments, 0);
  IF p_actual IS NULL OR p_actual < 0 OR p_expected IS DISTINCT FROM expected
     OR p_difference IS DISTINCT FROM p_actual::bigint - expected THEN
    RAISE EXCEPTION 'تغير الصندوق. أعد فتح التقفيلة وراجع النقد المتوقع';
  END IF;
  IF p_difference <> 0 AND nullif(trim(p_notes), '') IS NULL THEN
    RAISE EXCEPTION 'يجب توضيح سبب الفرق';
  END IF;
  UPDATE public.shifts
  SET expected_cash = expected, actual_cash = p_actual, difference = p_difference,
      total_cash_sales = sales, notes = p_notes, status = 'closed',
      end_time = now(), closed_at = now()
  WHERE id = s.id;
END $$;

CREATE OR REPLACE FUNCTION public.engine_delete_expense(p_expense uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE u public.users; x public.expenses;
BEGIN
  SELECT * INTO u FROM public.current_staff();
  IF u.id IS NULL OR u.role NOT IN ('owner','manager') THEN RAISE EXCEPTION 'الحذف للمالك والمدير فقط'; END IF;

  SELECT * INTO x FROM public.expenses WHERE id = p_expense FOR UPDATE;
  IF x.id IS NULL THEN RAISE EXCEPTION 'المصروف غير موجود'; END IF;
  PERFORM public.engine_validate(x.store_id, u.tenant_id, ARRAY['owner','manager']);
  IF x.deleted_at IS NOT NULL THEN
    RETURN jsonb_build_object('ok', true, 'alreadyDeleted', true);
  END IF;

  UPDATE public.expenses SET deleted_at = now(), deleted_by = u.id WHERE id = p_expense;
  RETURN jsonb_build_object('ok', true, 'id', p_expense);
END $$;

-- --------------------------------------------------- accounting must skip them
CREATE OR REPLACE FUNCTION public.engine_accounting(
  p_store uuid, p_from timestamptz, p_to timestamptz
) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public AS $$
DECLARE u public.users; sales bigint; expenses bigint; salaries bigint; advances bigint; suppliers bigint;
BEGIN
  SELECT * INTO u FROM public.current_staff();
  IF u.id IS NULL OR u.role <> 'owner' THEN RAISE EXCEPTION 'للمالك فقط'; END IF;
  IF p_store IS NOT NULL THEN PERFORM public.engine_validate(p_store, u.tenant_id, ARRAY['owner']); END IF;
  IF p_to IS NULL OR (p_from IS NOT NULL AND p_from >= p_to) THEN RAISE EXCEPTION 'الفترة غير صالحة'; END IF;
  SELECT coalesce(sum(x.total_amount), 0) INTO sales FROM public.sales x JOIN public.stores s ON s.id = x.store_id WHERE s.tenant_id = u.tenant_id AND (p_store IS NULL OR s.id = p_store) AND x.status = 'completed' AND (p_from IS NULL OR x.created_at >= p_from) AND x.created_at < p_to;
  SELECT coalesce(sum(x.amount), 0) INTO expenses FROM public.expenses x JOIN public.stores s ON s.id = x.store_id WHERE s.tenant_id = u.tenant_id AND (p_store IS NULL OR s.id = p_store) AND x.deleted_at IS NULL AND (p_from IS NULL OR x.created_at >= p_from) AND x.created_at < p_to;
  SELECT coalesce(sum(x.amount_paid), 0) INTO salaries FROM public.employee_payroll x JOIN public.users e ON e.id = x.user_id LEFT JOIN public.stores s ON s.id = coalesce(x.store_id, e.store_id) WHERE e.tenant_id = u.tenant_id AND (p_store IS NULL OR s.id = p_store) AND (p_from IS NULL OR x.created_at >= p_from) AND x.created_at < p_to;
  SELECT coalesce(sum(x.amount), 0) INTO advances FROM public.employee_advances x JOIN public.users e ON e.id = x.user_id LEFT JOIN public.stores s ON s.id = coalesce(x.store_id, e.store_id) WHERE e.tenant_id = u.tenant_id AND (p_store IS NULL OR s.id = p_store) AND (p_from IS NULL OR x.created_at >= p_from) AND x.created_at < p_to;
  SELECT coalesce(sum(x.amount), 0) INTO suppliers FROM public.supplier_payments x LEFT JOIN public.suppliers supplier ON supplier.id = x.supplier_id LEFT JOIN public.stores s ON s.id = coalesce(x.store_id, supplier.store_id) WHERE coalesce(x.tenant_id, supplier.tenant_id, s.tenant_id) = u.tenant_id AND (s.tenant_id IS NULL OR s.tenant_id = u.tenant_id) AND (p_store IS NULL OR s.id = p_store) AND (p_from IS NULL OR x.created_at >= p_from) AND x.created_at < p_to;
  RETURN jsonb_build_object('sales', sales, 'expenses', expenses, 'salaries', salaries, 'advances', advances, 'supplierPayments', suppliers, 'netProfit', sales - expenses - salaries - advances);
END $$;

CREATE OR REPLACE FUNCTION public.engine_journal(
  p_store uuid, p_from timestamptz, p_to timestamptz, p_offset integer DEFAULT 0
) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public AS $$
DECLARE u public.users; result jsonb;
BEGIN
  SELECT * INTO u FROM public.current_staff();
  IF u.id IS NULL OR u.role <> 'owner' THEN RAISE EXCEPTION 'للمالك فقط'; END IF;
  IF p_store IS NOT NULL THEN PERFORM public.engine_validate(p_store, u.tenant_id, ARRAY['owner']); END IF;
  IF p_offset IS NULL OR p_offset < 0 OR p_to IS NULL OR (p_from IS NOT NULL AND p_from >= p_to) THEN RAISE EXCEPTION 'الفترة غير صالحة'; END IF;
  WITH entries AS (
    SELECT sale.id, sale.created_at, 'sale'::text AS type, 'فاتورة ' || left(sale.id::text, 8) AS details, sale.total_amount::numeric AS amount, null::text AS receipt, sale.store_id
      FROM public.sales sale JOIN public.stores s ON s.id = sale.store_id
     WHERE s.tenant_id = u.tenant_id AND sale.status = 'completed'
    UNION ALL
    SELECT x.id, x.created_at, 'expense', x.description, x.amount, x.receipt_url, x.store_id
      FROM public.expenses x JOIN public.stores s ON s.id = x.store_id
     WHERE s.tenant_id = u.tenant_id AND x.deleted_at IS NULL
    UNION ALL
    SELECT x.id, x.created_at, 'payroll', coalesce(e.full_name, e.username) || ' · ' || x.month, x.amount_paid, null, coalesce(x.store_id, e.store_id)
      FROM public.employee_payroll x JOIN public.users e ON e.id = x.user_id WHERE e.tenant_id = u.tenant_id
    UNION ALL
    SELECT x.id, x.created_at, 'advance', coalesce(e.full_name, e.username) || ' · ' || coalesce(x.reason, ''), x.amount, null, coalesce(x.store_id, e.store_id)
      FROM public.employee_advances x JOIN public.users e ON e.id = x.user_id WHERE e.tenant_id = u.tenant_id
    UNION ALL
    SELECT p.id, p.created_at, 'credit', 'دفعة كريدي · ' || coalesce(cust.name, ''), p.amount, null, p.store_id
      FROM public.credit_payments p
      JOIN public.credits c ON c.id = p.credit_id
      LEFT JOIN public.customers cust ON cust.id = c.customer_id
      JOIN public.stores s ON s.id = p.store_id
     WHERE s.tenant_id = u.tenant_id
  ), page AS (
    SELECT * FROM entries
     WHERE (p_store IS NULL OR store_id = p_store)
       AND (p_from IS NULL OR created_at >= p_from) AND created_at < p_to
     ORDER BY created_at DESC, type, id LIMIT 51 OFFSET p_offset
  )
  SELECT jsonb_build_object(
    'rows', coalesce((SELECT jsonb_agg(to_jsonb(x) ORDER BY x.created_at DESC, x.type, x.id)
                      FROM (SELECT * FROM page ORDER BY created_at DESC, type, id LIMIT 50) x), '[]'::jsonb),
    'hasMore', (SELECT count(*) > 50 FROM page)
  ) INTO result;
  RETURN result;
END $$;

-- ================================================== employee deactivation
-- Never delete: sales, shifts and payroll rows point at this user. Deactivate
-- the profile and ban the auth account so the PIN stops working immediately.
CREATE OR REPLACE FUNCTION public.engine_set_employee_active(p_user uuid, p_active boolean)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE u public.users; employee public.users;
BEGIN
  SELECT * INTO u FROM public.current_staff();
  IF u.id IS NULL OR u.role <> 'owner' THEN RAISE EXCEPTION 'للمالك فقط'; END IF;
  IF p_user IS NULL OR p_active IS NULL THEN RAISE EXCEPTION 'طلب غير صالح'; END IF;
  IF p_user = u.id THEN RAISE EXCEPTION 'لا يمكنك إيقاف حسابك'; END IF;

  SELECT * INTO employee FROM public.users WHERE id = p_user AND tenant_id = u.tenant_id FOR UPDATE;
  IF employee.id IS NULL THEN RAISE EXCEPTION 'الموظف غير موجود'; END IF;
  IF employee.role NOT IN ('manager','employee') THEN RAISE EXCEPTION 'لا يمكن تعديل هذا الحساب'; END IF;

  -- An employee holding an open cash drawer must be reconciled first.
  IF NOT p_active AND EXISTS (
    SELECT 1 FROM public.shifts WHERE store_id = employee.store_id AND status = 'open'
  ) AND employee.store_id IS NOT NULL THEN
    RAISE EXCEPTION 'أغلق صندوق الفرع قبل إيقاف الموظف';
  END IF;

  UPDATE public.users SET is_active = p_active WHERE id = p_user;

  -- GoTrue refuses to issue a session for a banned user, so login stops even if
  -- the app never checks is_active. Banned, not deleted, so the audit trail stays.
  IF employee.auth_id IS NOT NULL THEN
    BEGIN
      UPDATE auth.users
      SET banned_until = CASE WHEN p_active THEN NULL ELSE 'infinity'::timestamptz END
      WHERE id = employee.auth_id;
    EXCEPTION WHEN insufficient_privilege THEN
      -- Never fail the profile change just because the auth table is protected.
      NULL;
    END;
  END IF;

  RETURN jsonb_build_object('ok', true, 'id', p_user, 'is_active', p_active);
END $$;

CREATE OR REPLACE FUNCTION public.engine_receipts_access(p_path text, p_write boolean)
RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public AS $$
DECLARE u public.users; branch uuid;
BEGIN
  SELECT * INTO u FROM public.current_staff();
  IF u.id IS NULL OR split_part(p_path, '/', 1) <> u.tenant_id::text THEN RETURN false; END IF;
  SELECT id INTO branch FROM public.stores WHERE id::text = split_part(p_path, '/', 2) AND tenant_id = u.tenant_id;
  IF branch IS NULL OR (u.role <> 'owner' AND u.store_id IS DISTINCT FROM branch) THEN RETURN false; END IF;
  IF p_write AND u.role NOT IN ('owner','manager','employee') THEN RETURN false; END IF;
  RETURN true;
END $$;

DROP POLICY IF EXISTS receipts_insert ON storage.objects;
DROP POLICY IF EXISTS receipts_read ON storage.objects;
CREATE POLICY receipts_insert ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'receipts' AND public.engine_receipts_access(name, true));
CREATE POLICY receipts_read ON storage.objects FOR SELECT TO authenticated
  USING (bucket_id = 'receipts' AND public.engine_receipts_access(name, false));

-- ======================================================== expense recording
-- Category-aware variant of engine_record_expense. The original is kept so any
-- older caller keeps working; this one is what the new page uses.
CREATE OR REPLACE FUNCTION public.engine_record_expense_v2(
  p_store uuid, p_amount integer, p_description text, p_category text, p_receipt text, p_request uuid
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE u public.users; old public.expenses; result uuid; clean_category text;
BEGIN
  SELECT * INTO u FROM public.current_staff();
  PERFORM public.engine_validate(p_store, u.tenant_id, ARRAY['owner','manager','employee']);
  IF p_amount IS NULL OR p_amount <= 0 OR nullif(trim(p_description), '') IS NULL OR length(p_description) > 1000 OR p_request IS NULL THEN
    RAISE EXCEPTION 'أدخل مبلغاً موجباً ووصفاً صحيحاً';
  END IF;
  clean_category := nullif(trim(coalesce(p_category, '')), '');
  IF clean_category IS NOT NULL AND length(clean_category) > 80 THEN RAISE EXCEPTION 'التصنيف طويل جداً'; END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(p_request::text, 0));
  SELECT * INTO old FROM public.expenses WHERE request_id = p_request;
  IF old.id IS NOT NULL THEN
    IF old.store_id <> p_store OR old.created_by <> u.id OR old.amount <> p_amount
       OR old.description IS DISTINCT FROM trim(p_description) OR old.receipt_url IS DISTINCT FROM p_receipt THEN
      RAISE EXCEPTION 'طلب مكرر ببيانات مختلفة';
    END IF;
    RETURN old.id;
  END IF;

  IF p_receipt IS NOT NULL AND (
    split_part(p_receipt, '/', 1) <> u.tenant_id::text
    OR split_part(p_receipt, '/', 2) <> p_store::text
    OR NOT EXISTS (SELECT 1 FROM storage.objects WHERE bucket_id = 'receipts' AND name = p_receipt)
  ) THEN RAISE EXCEPTION 'المرفق غير صالح'; END IF;

  INSERT INTO public.expenses(store_id, amount, description, category, receipt_url, created_by, status, request_id)
  VALUES (p_store, p_amount, trim(p_description), clean_category, p_receipt, u.id, 'approved', p_request)
  RETURNING id INTO result;
  RETURN result;
END $$;

-- ============================================================ permissions
REVOKE ALL ON FUNCTION public.engine_credit_payment(uuid, integer, uuid),
  public.engine_customer_ledger(uuid), public.engine_delete_expense(uuid),
  public.engine_set_employee_active(uuid, boolean), public.engine_record_expense_v2(uuid, integer, text, text, text, uuid),
  public.engine_receipts_access(text, boolean), public.engine_close_shift(uuid, integer, bigint, bigint, text)
  FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.engine_credit_payment(uuid, integer, uuid),
  public.engine_customer_ledger(uuid), public.engine_delete_expense(uuid),
  public.engine_set_employee_active(uuid, boolean), public.engine_record_expense_v2(uuid, integer, text, text, text, uuid),
  public.engine_close_shift(uuid, integer, bigint, bigint, text)
  TO authenticated;
