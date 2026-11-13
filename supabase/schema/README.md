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

## Usage

```bash
node scripts/check-insert-columns.mjs --file supabase/schema/columns.tsv supabase/seed_data.sql
```

Run this before changing `seed_data.sql`.
