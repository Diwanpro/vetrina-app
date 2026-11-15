import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'

const sql = await fs.readFile(
  new URL('../supabase/migrations/202611120018_store_type_and_order_media.sql', import.meta.url), 'utf8')

test('store_type is mandatory, checked and exposed to the public storefront', () => {
  assert.match(sql, /ALTER TABLE public\.stores ADD COLUMN IF NOT EXISTS store_type text/)
  assert.match(sql, /ALTER TABLE public\.stores ALTER COLUMN store_type SET NOT NULL/)
  assert.match(sql, /CHECK \(store_type IN \('mens', 'womens'\)\)/)
  assert.match(sql, /'store_type', coalesce\(s\.store_type, 'mens'\)/)
  assert.match(sql, /'store_type', coalesce\(store_type, 'mens'\)/)
  assert.match(sql, /GRANT EXECUTE ON FUNCTION public\.get_store_by_slug\(text\) TO anon, authenticated/)
})

test('signup, branch creation and settings make the store type mandatory', () => {
  assert.match(sql, /public\.engine_create_trial_tenant\(\s*p_store_name text,\s*p_owner_name text,\s*p_phone text,\s*p_store_type text\s*\)/)
  assert.match(sql, /REVOKE ALL ON FUNCTION public\.engine_create_trial_tenant\(text,text,text\) FROM PUBLIC, anon, authenticated/)
  assert.match(sql, /GRANT EXECUTE ON FUNCTION public\.engine_create_trial_tenant\(text,text,text,text\) TO authenticated/)
  assert.match(sql, /CREATE OR REPLACE FUNCTION public\.engine_add_store\(p_name text, p_address text, p_store_type text\)/)
  assert.match(sql, /GRANT EXECUTE ON FUNCTION public\.engine_add_store\(text,text,text\) TO authenticated/)
  assert.match(sql, /p_store_type\s+text/)
  assert.match(sql, /IF p_store_type NOT IN \('mens', 'womens'\) THEN RAISE EXCEPTION 'نوع المتجر مطلوب'/)
  assert.match(sql, /GRANT EXECUTE ON FUNCTION public\.engine_update_store_settings\(uuid,text,text,text,text,text,text,boolean,boolean,integer,integer,boolean,text,text\)/)
})

test('the session carries the branch type and the old mixed seed is hidden', () => {
  assert.match(sql, /CREATE OR REPLACE FUNCTION public\.engine_session\(\) RETURNS jsonb/)
  assert.match(sql, /'storeType', coalesce\(\(SELECT store_type FROM public\.stores WHERE id = u\.store_id\), 'mens'\)/)
  assert.match(sql, /UPDATE public\.products SET is_active = false WHERE name LIKE '\[seed\] %'/)
})

test('public.orders stays read-only in the P5 migration', () => {
  for (const forbidden of [
    /ALTER\s+TABLE\s+public\.orders\b/i,
    /UPDATE\s+public\.orders\b/i,
    /INSERT\s+INTO\s+public\.orders\b/i,
    /DELETE\s+FROM\s+public\.orders\b/i,
  ]) assert.doesNotMatch(sql, forbidden)
  assert.match(sql, /ALTER TABLE public\.order_items ADD COLUMN IF NOT EXISTS image_url text/)
})
