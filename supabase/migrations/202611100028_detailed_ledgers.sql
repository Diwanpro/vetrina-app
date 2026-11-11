-- 028: chronological ledgers for a customer and for a supplier
--
-- Both are built server-side so the browser never has to join four tables and
-- guess at column names, and so the running balance is computed from the same
-- rows the user is looking at.
--
-- Columns are identical on both sides: date, description, total, cash, paper
-- (cheque/CCP), remaining. For a supplier "cash" is money paid to them; for a
-- customer it is money they paid. Nothing here books revenue: these are the
-- movements of an existing balance.
--
-- Apply after 027. Idempotent.

-- Pending collections are not part of the supplier ledger: that table records
-- money a CUSTOMER owes the shop and has no supplier_id, so a store-level
-- filter would show every unrelated cheque on every supplier. Attributing a
-- cheque to a supplier needs a supplier_id column on pending_collections first.
--
-- ------------------------------------------------------------- supplier
CREATE OR REPLACE FUNCTION public.engine_supplier_ledger_detail(p_supplier uuid)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public AS $$
DECLARE u public.users; s public.suppliers; entries jsonb; total_in bigint := 0; paid_cash bigint := 0; paid_paper bigint := 0;
BEGIN
  SELECT * INTO u FROM public.current_staff();
  IF u.id IS NULL THEN RAISE EXCEPTION 'غير مصرح'; END IF;
  SELECT * INTO s FROM public.suppliers WHERE id = p_supplier AND tenant_id = u.tenant_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'المورد غير موجود'; END IF;

  WITH movement AS (
    -- What the shop owes: goods received on account.
    SELECT p.created_at AS at, 'purchase'::text AS kind,
           'فاتورة شراء'::text AS label,
           coalesce(p.supplier_name, '')::text AS detail,
           p.total_amount::bigint AS total, 0::bigint AS cash, 0::bigint AS paper, 0::bigint AS credit
      FROM public.purchases p
     WHERE p.supplier_id = s.id AND p.tenant_id = u.tenant_id
    UNION ALL
    -- What the shop paid in cash.
    SELECT sp.created_at, 'payment',
           'دفعة نقدية',
           ''::text,
           0::bigint, sp.amount::bigint, 0::bigint, 0::bigint
      FROM public.supplier_payments sp
     WHERE sp.supplier_id = s.id
  ), ordered AS (
    SELECT *, sum(total) OVER (ORDER BY at, kind) AS running_total,
              sum(cash) OVER (ORDER BY at, kind) AS running_cash,
              sum(paper) OVER (ORDER BY at, kind) AS running_paper
      FROM movement
  )
  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'date', at, 'kind', kind, 'label', label, 'detail', detail,
           'total', total, 'cash', cash, 'paper', paper,
           'remaining', running_total - running_cash - running_paper
         ) ORDER BY at, kind), '[]'::jsonb),
         coalesce(sum(total), 0)::bigint, coalesce(sum(cash), 0)::bigint, coalesce(sum(paper), 0)::bigint
    INTO entries, total_in, paid_cash, paid_paper
    FROM ordered;
  -- A supplier with no movements still gets an empty array, never NULL, so the
  -- modal renders "no entries yet" instead of crashing on .length.

  RETURN jsonb_build_object(
    'supplier', jsonb_build_object('id', s.id, 'name', s.name, 'phone', s.phone, 'storeId', s.store_id),
    'entries', entries,
    'totalPurchases', total_in, 'totalCash', paid_cash, 'totalPaper', paid_paper,
    'remaining', coalesce(s.total_debt, 0)
  );
END $$;

-- ------------------------------------------------------------- customer
CREATE OR REPLACE FUNCTION public.engine_customer_ledger_detail(p_customer uuid)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public AS $$
DECLARE u public.users; c public.customers; entries jsonb;
BEGIN
  SELECT * INTO u FROM public.current_staff();
  IF u.id IS NULL THEN RAISE EXCEPTION 'غير مصرح'; END IF;
  SELECT * INTO c FROM public.customers WHERE id = p_customer AND tenant_id = u.tenant_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'الزبون غير موجود'; END IF;

  WITH movement AS (
    -- The debt itself, with whatever was paid at the till attached to it.
    SELECT cr.created_at AS at, 'credit'::text AS kind,
           'دين'::text AS label,
           coalesce(nullif(cr.description, ''), 'فاتورة كريدي')::text AS detail,
           cr.total_amount::bigint AS total, 0::bigint AS cash, 0::bigint AS paper
      FROM public.credits cr
     WHERE cr.customer_id = c.id
    UNION ALL
    -- Payments against a debt. The method decides which bucket it lands in.
    SELECT cp.created_at, 'payment',
           CASE cp.payment_method WHEN 'cash' THEN 'دفعة نقدية' WHEN 'check' THEN 'دفعة شيك' ELSE 'دفعة بريدية' END,
           ''::text,
           0::bigint,
           CASE WHEN cp.payment_method = 'cash' THEN cp.amount::bigint ELSE 0::bigint END,
           CASE WHEN cp.payment_method IN ('check','ccp') THEN cp.amount::bigint ELSE 0::bigint END
      FROM public.credit_payments cp
      JOIN public.credits cr ON cr.id = cp.credit_id
     WHERE cr.customer_id = c.id
  ), ordered AS (
    SELECT *, sum(total) OVER (ORDER BY at, kind) AS running_total,
              sum(cash) OVER (ORDER BY at, kind) AS running_cash,
              sum(paper) OVER (ORDER BY at, kind) AS running_paper
      FROM movement
  )
  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'date', at, 'kind', kind, 'label', label, 'detail', detail,
           'total', total, 'cash', cash, 'paper', paper,
           'remaining', running_total - running_cash - running_paper
         ) ORDER BY at, kind), '[]'::jsonb)
    INTO entries
    FROM ordered;

  RETURN jsonb_build_object(
    'customer', jsonb_build_object('id', c.id, 'name', c.name, 'phone', c.phone),
    'entries', entries,
    'remaining', (
      SELECT coalesce(sum(x.remaining_amount), 0) FROM public.credits x
       WHERE x.customer_id = c.id AND x.status <> 'paid' AND x.remaining_amount > 0
    )
  );
END $$;

REVOKE ALL ON FUNCTION public.engine_supplier_ledger_detail(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.engine_supplier_ledger_detail(uuid) TO authenticated;
REVOKE ALL ON FUNCTION public.engine_customer_ledger_detail(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.engine_customer_ledger_detail(uuid) TO authenticated;
