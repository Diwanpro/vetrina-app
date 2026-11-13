# Recorded production schema

`columns.tsv` is the column list for `public`, pasted from the live project.

Format, one column per line:

```
table_name <TAB> column_name <TAB> is_nullable <TAB> column_default <TAB> data_type <TAB> character_maximum_length
```

`column_default` is `-` for "no default" and `UNKNOWN` for "the source did not
say". The checker treats `UNKNOWN` as unproven, never as "no default" —
conflating them produced false `NOT NULL` failures on `id` columns.

`id` is recorded as defaulting to `gen_random_uuid()` on every table: the
application inserts into these tables without passing `id` and works in
production, which is proof the default exists.

## Known disagreement

`suppliers.store_id` is listed as absent here, but migration
`202611100002_engine.sql` adds it, `engine_add_supplier()` writes it, and the
`engine_suppliers_read` RLS policy filters on it. All three would fail if the
column were genuinely missing, so the live table very likely has it.

`seed_data.sql` therefore does not rely on either answer: it checks
`information_schema.columns` and inserts the column only when it exists.

## Tables added from DDL rather than from the paste

`orders`, `order_items` and `order_status_history` were appended from the
`CREATE TABLE` statements in
`supabase/migrations/202611120005_ecommerce_phase_a.sql`, which is the
authoritative source for them. Their constraints are recorded there too and the
seed respects them literally — notably
`payment_method IN ('cod')` and
`fulfillment_type IN ('delivery','pickup')`.

## Generated columns

`day_closes.difference` is `GENERATED ALWAYS AS (actual_cash - expected_cash)
STORED` in the live database. The paste format has no column for generation, so
it is recorded in the `column_default` slot with its expression; the checker
recognises any value beginning `GENERATED` there and fails the insert with
`428C9`. Naming the column at all is the mistake — supplying a value, an
expression or even an omission of the arithmetic does not help, because the
database computes it.

**`shifts.difference` is the opposite** and must not be removed. It was
converted *from* a generated expression to a plain writable column (see
`lib/cash.js`), and the POS inserts it on every shift open through
`cashReconciliation()`. The two columns share a name and behave differently;
`tests/seed-schema.test.mjs` pins both directions so an over-correction fails
too.

`shifts` was reconstructed from the migrations that alter it
(`202611100001`, `202611100005`, `202611100022`, `202611100025`) plus the reads
and writes in `components/dashboard/ShiftManager.js`. Its defaults are recorded
as `UNKNOWN` where no source states them, which is honest: `UNKNOWN` is treated
as "unproven", never as "no default", so it can suppress a false failure but
never invent one. The column names themselves are certain — `engine_close_shift`
writes every one of them.

## Usage

```bash
node scripts/check-insert-columns.mjs --file supabase/schema/columns.tsv supabase/seed_data.sql
```

Run this before changing `seed_data.sql`.
