import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'

const read = file => fs.readFile(new URL(`../${file}`, import.meta.url), 'utf8')
const sql = await read('supabase/migrations/202611130019_branch_specialty_themes_and_push.sql')

test('migration 019 makes specialty branch-level and adds a checked branch theme', () => {
  assert.match(sql, /CHECK \(store_type IN \('mens', 'womens', 'mixed'\)\)/)
  assert.match(sql, /ADD COLUMN IF NOT EXISTS theme_key text/)
  assert.match(sql, /ALTER TABLE public\.stores ALTER COLUMN theme_key SET NOT NULL/)
  assert.match(sql, /CHECK \(theme_key IN \('classic', 'feminine'\)\)/)
  assert.match(sql, /CREATE OR REPLACE FUNCTION public\.engine_list_branch_profiles\(\)/)
  assert.match(sql, /CREATE OR REPLACE FUNCTION public\.engine_set_branch_profile\(/)
  assert.match(sql, /GRANT EXECUTE ON FUNCTION public\.engine_set_branch_profile\(uuid,text,text\) TO authenticated/)
  assert.match(sql, /GRANT EXECUTE ON FUNCTION public\.engine_list_branch_profiles\(\) TO authenticated/)
})

test('settings, signup, branch creation and session all accept the mixed specialty', () => {
  assert.match(sql, /public\.engine_create_trial_tenant\([\s\S]*?p_store_type NOT IN \('mens', 'womens', 'mixed'\)/)
  assert.match(sql, /CREATE OR REPLACE FUNCTION public\.engine_add_store\(p_name text, p_address text, p_store_type text\)/)
  assert.match(sql, /IF p_store_type NOT IN \('mens', 'womens', 'mixed'\) THEN RAISE EXCEPTION 'تخصص الفرع مطلوب'/)
  assert.match(sql, /p_theme_key\s+text/)
  assert.match(sql, /DROP FUNCTION IF EXISTS public\.engine_update_store_settings\(uuid,text,text,text,text,text,text,boolean,boolean,integer,integer,boolean,text,text\)/)
  assert.match(sql, /GRANT EXECUTE ON FUNCTION public\.engine_update_store_settings\(uuid,text,text,text,text,text,text,boolean,boolean,integer,integer,boolean,text,text,text\)/)
  assert.match(sql, /'themeKey', coalesce\(\(SELECT theme_key FROM public\.stores WHERE id = u\.store_id\), 'classic'\)/)
  assert.match(sql, /'theme_key', coalesce\(theme_key, 'classic'\)/)
  assert.match(sql, /'slug', s\.slug/)
  assert.match(sql, /'theme_key', coalesce\(s\.theme_key, 'classic'\)/)
})

test('legacy overloads cannot bypass the mandatory branch specialty', () => {
  assert.match(sql, /REVOKE ALL ON FUNCTION public\.engine_add_store\(text,text\) FROM PUBLIC, anon, authenticated/)
  assert.match(sql, /REVOKE ALL ON FUNCTION public\.engine_update_store_settings\(uuid,text,text,text,text,text,boolean,boolean,integer,integer,boolean,text\)/)
  assert.match(sql, /REVOKE ALL ON FUNCTION public\.engine_update_store_settings\(uuid,text,text,text,text,text,text,boolean,boolean,integer,integer,boolean,text\)/)
  assert.match(sql, /DROP FUNCTION IF EXISTS public\.engine_update_store_settings\(uuid,text,text,text,text,text,text,boolean,boolean,integer,integer,boolean,text,text\)/)
})

test('demo branches demonstrate three different specialties under one tenant', async () => {
  assert.match(sql, /SET store_type = 'mixed', theme_key = 'feminine'/)
  assert.match(sql, /WHERE slug = 'seed-branch-2'/)
  assert.match(sql, /WHERE slug = 'seed-branch-3'/)
  const seed = await read('supabase/seed_data.sql')
  assert.match(seed, /'seed-branch-2', true, true, 'mixed', 'feminine'/)
  assert.match(seed, /'seed-branch-3', true, true, 'womens', 'classic'/)
  const dump = await read('supabase/schema/columns.tsv')
  assert.match(dump, /stores\ttheme_key\tNO/)
})

test('public.orders stays read-only and the push table is locked down', () => {
  for (const forbidden of [
    /ALTER\s+TABLE\s+public\.orders\b/i,
    /UPDATE\s+public\.orders\b/i,
    /INSERT\s+INTO\s+public\.orders\b/i,
    /DELETE\s+FROM\s+public\.orders\b/i,
  ]) assert.doesNotMatch(sql, forbidden)
  assert.match(sql, /UPDATE public\.products SET is_active = false WHERE name LIKE '\[seed\] %'/)
  assert.match(sql, /REVOKE ALL ON TABLE public\.push_subscriptions FROM PUBLIC, anon, authenticated/)
  assert.match(sql, /GRANT ALL ON TABLE public\.push_subscriptions TO service_role/)
  assert.match(sql, /REVOKE ALL ON FUNCTION public\.get_store_by_slug\(text\) FROM PUBLIC, anon, authenticated/)
  assert.match(sql, /GRANT EXECUTE ON FUNCTION public\.get_store_by_slug\(text\) TO anon, authenticated/)
})
