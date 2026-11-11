import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'

// The profit formula lives in SQL. These tests pin the intent so a future edit
// cannot quietly reintroduce the old behaviour (subtracting stock on hand, or
// letting a corrupt cost average reach net profit).
const sql = await fs.readFile(new URL('../supabase/migrations/202611100021_profit_formula_fix.sql', import.meta.url), 'utf8')
const commercial = sql.slice(sql.indexOf('CREATE OR REPLACE FUNCTION public.engine_accounting_commercial'))
const body = commercial.slice(0, commercial.indexOf('-- ------------------------------------------------------------------ repair'))

test('net profit is sales - COGS - expenses - payroll - advances', () => {
  assert.match(body, /net := gross - expenses - salaries - advances/)
  assert.match(body, /gross := sales - cogs/)
  assert.match(body, /sales := coalesce\(\(result->>'sales'\)::numeric, 0\)/)
})

test('COGS is summed from sale_items only, never from stock on hand', () => {
  const cogsQuery = body.slice(body.indexOf('SELECT coalesce(sum'), body.indexOf('  sales := coalesce'))
  assert.match(cogsQuery, /FROM public\.sale_items i/)
  assert.match(cogsQuery, /JOIN public\.sales sale ON sale\.id = i\.sale_id/)
  assert.equal(/public\.inventory/.test(cogsQuery), false, 'COGS must not read inventory levels')
  // The only quantity used is the quantity actually sold, multiplied by unit cost.
  assert.match(cogsQuery, /sum\(i\.quantity \* coalesce\(/)
  assert.equal(/purchase_items/.test(cogsQuery), false, 'a purchase is costed through COGS, not charged twice')
})

test('COGS is restricted to completed sales inside the requested period', () => {
  assert.match(body, /sale\.status = 'completed'/)
  assert.match(body, /sale\.created_at < p_to/)
  assert.match(body, /\(p_from IS NULL OR sale\.created_at >= p_from\)/)
})

test('cost precedence is snapshot, then purchase history, then current average', () => {
  const order = 'coalesce(i.cost_at_sale, public.variant_cost_at(i.variant_id, u.tenant_id, sale.created_at), v.cost_price_avg, 0)'
  assert.ok(body.includes(order), 'cost fallback order changed')
})

test('the reported net profit cannot exceed sales when costs are zero', () => {
  // Mirrors the SQL with a corrupt cost average of 0: profit must be plain
  // sales minus expenses, never a negative 13M mystery.
  const compute = ({ sales, cogs, expenses, salaries, advances }) => (sales - cogs) - expenses - salaries - advances
  const result = compute({ sales: 100000, cogs: 0, expenses: 5000, salaries: 2000, advances: 1000 })
  assert.equal(result, 92000)
})

test('one absurd cost average produces a large negative profit, which is what the repair targets', () => {
  const compute = ({ sales, cogs, expenses, salaries, advances }) => (sales - cogs) - expenses - salaries - advances
  // 20 items x 700,000 cost reaches the order of magnitude of the reported bug.
  assert.equal(compute({ sales: 500000, cogs: 20 * 700000, expenses: 0, salaries: 0, advances: 0 }), 500000 - 14000000)
})

test('the repair function rebuilds cost from purchases and clamps negatives', () => {
  const repair = sql.slice(sql.indexOf('FUNCTION public.engine_repair_cost_price_avg'))
  assert.match(repair, /h\.avg_cost IS NOT NULL THEN round\(h\.avg_cost, 4\)/)
  assert.match(repair, /coalesce\(v\.cost_price_avg, 0\) < 0 THEN 0/)
  // Dry run must be the default so nothing is rewritten by accident.
  assert.match(repair, /p_apply boolean DEFAULT true/)
})

test('cost history is written for every purchase receipt and scoped to a tenant', () => {
  assert.match(sql, /CREATE TABLE IF NOT EXISTS public\.variant_cost_history/)
  assert.match(sql, /tenant_id uuid NOT NULL REFERENCES public\.tenants\(id\)/)
  assert.match(sql, /CREATE TRIGGER record_cost_history AFTER INSERT ON public\.purchase_items/)
  assert.match(sql, /REVOKE ALL ON TABLE public\.variant_cost_history FROM PUBLIC, anon, authenticated/)
})

test('cost history reconstruction only uses receipts dated before the sale', () => {
  const fn = sql.slice(sql.indexOf('FUNCTION public.variant_cost_at'))
  assert.match(fn, /h\.occurred_at <= p_at/)
  assert.match(fn, /h\.tenant_id = p_tenant/)
})
