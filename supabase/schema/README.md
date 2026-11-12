# Recorded production schema

`columns.tsv` is the column list for the tables in `public`, pasted from the live
project's `information_schema`. It is a **partial** dump: it covers tables
alphabetically from `alerts` to `expenses` and stops there.

Format, one column per line:

```
table_name <TAB> column_name <TAB> is_nullable <TAB> column_default <TAB> data_type <TAB> character_maximum_length
```

`column_default` is `UNKNOWN` where the source did not include it. The checker
treats `UNKNOWN` as "cannot prove", never as "no default" — assuming the latter
produced false `NOT NULL` errors on `id` columns that really default to
`gen_random_uuid()`.

## Why it is here

`supabase/seed_data.sql` failed six times in a row, each time on a column that
was not what we assumed. The tables it writes that are *not* in this file —
`stores`, `suppliers`, `products`, `product_variants`, `inventory`, `offers`,
`sales`, `sale_items`, `pending_collections`, `purchases`, `purchase_items` —
are still inferred from the migrations, and remain the most likely place for the
next failure.

## Usage

```bash
node scripts/check-insert-columns.mjs --file supabase/schema/columns.tsv supabase/seed_data.sql
```

Run this before changing `seed_data.sql`. To refresh the file, run the
`information_schema` query in the script's `--query` error message against the
live database and paste the result in, replacing the old contents wholesale.
