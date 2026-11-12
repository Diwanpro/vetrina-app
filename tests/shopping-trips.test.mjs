import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'

// A shopping trip's expenses are a cost of the goods, not a shop expense. If
// they ever reach `expenses`, engine_close_shift subtracts them from the
// expected drawer and every shift closed after a trip shows a false shortage.
// These tests pin the boundary and the arithmetic.
const sql = await fs.readFile(new URL('../supabase/migrations/202611120013_shopping_trips.sql', import.meta.url), 'utf8')

const tripBody = (() => {
  const start = sql.indexOf('CREATE OR REPLACE FUNCTION public.engine_save_trip')
  assert.ok(start > -1, 'engine_save_trip missing')
  const end = sql.indexOf('$$;', start)
  return sql.slice(start, end)
})()

test('a trip never writes to the expenses table', () => {
  // The whole point of the separate history tables: the drawer must not move.
  assert.doesNotMatch(tripBody, /INSERT\s+INTO\s+public\.expenses/i)
  assert.doesNotMatch(tripBody, /UPDATE\s+public\.expenses/i)
  // And it must not touch the drawer or a shift either.
  assert.doesNotMatch(tripBody, /public\.shifts/i)
  assert.doesNotMatch(tripBody, /expected_cash|actual_cash/i)
})

test('trip expenses are spread over every unit, floored, and added to cost', () => {
  // spread := floor(extras / units) — matches the screen's preview exactly.
  assert.match(tripBody, /spread\s*:=\s*floor\(extras\s*\/\s*units\)/)
  // The true cost is the goods unit cost plus that share, before the weighted
  // average against existing stock.
  assert.match(tripBody, /item\.quantity::numeric\s*\*\s*\(item\.unit_cost\s*\+\s*spread\)/)
  // Weighted into cost_price_avg against all stock in the tenant.
  assert.match(tripBody, /UPDATE public\.product_variants SET cost_price_avg\s*=\s*amount/)
})

test('the purchase total is goods only, so supplier debt excludes the journey', () => {
  // A supplier did not charge us for the bus fare; total_amount is the invoice.
  assert.match(tripBody, /INSERT INTO public\.purchases\([\s\S]*?VALUES \(\s*p_store,\s*p_tenant,\s*p_supplier,[\s\S]*?goods,\s*'received'/)
  assert.match(tripBody, /UPDATE public\.suppliers SET total_debt\s*=\s*coalesce\(total_debt,\s*0\)\s*\+\s*goods::integer/)
})

test('saving a trip is idempotent on the request id', () => {
  assert.match(tripBody, /pg_advisory_xact_lock\(hashtextextended\(p_request::text, 0\)\)/)
  assert.match(tripBody, /SELECT \* INTO previous FROM public\.shopping_trips WHERE request_id = p_request/)
  assert.match(tripBody, /RAISE EXCEPTION 'طلب رحلة مكرر بقيم مختلفة'/)
})

test('both history tables are locked down, since 011 swept the catalogue earlier', () => {
  for (const table of ['shopping_trips', 'shopping_trip_expenses']) {
    assert.match(sql, new RegExp(`ALTER TABLE public\\.${table}\\s+ENABLE ROW LEVEL SECURITY`))
    assert.match(sql, new RegExp(`REVOKE ALL ON TABLE public\\.${table} FROM PUBLIC, anon, authenticated`))
  }
  // Writes are RPC-only: a read policy, never an insert/update one.
  assert.doesNotMatch(sql, /CREATE POLICY \w+ ON public\.shopping_trips FOR (INSERT|UPDATE|DELETE)/)
  assert.doesNotMatch(sql, /CREATE POLICY \w+ ON public\.shopping_trip_expenses FOR (INSERT|UPDATE|DELETE)/)
})

test('staff must own the store to save a trip into it', () => {
  assert.match(tripBody, /staff := public\.engine_staff\(p_store, p_tenant\)/)
  assert.match(tripBody, /IF NOT FOUND THEN RAISE EXCEPTION 'المقاس لا ينتمي إلى المؤسسة'/)
})

import { tripTotals } from '../lib/trips.js'

test('the preview the owner sees matches the SQL exactly', () => {
  // 3 units, 10 000 DA of journey -> 3 333 per unit, and 1 DA is deliberately
  // NOT rounded away: a floor is what the RPC writes.
  const { goods, units, extras, spread } = tripTotals(
    [{ quantity: 2, unit_cost: 1500 }, { quantity: 1, unit_cost: 2000 }],
    [{ amount: '6000' }, { amount: '4000' }],
  )
  assert.equal(goods, 5000)
  assert.equal(units, 3)
  assert.equal(extras, 10000)
  assert.equal(spread, 3333)
})

test('a trip with no expenses spreads nothing, and an empty trip cannot divide by zero', () => {
  assert.equal(tripTotals([{ quantity: 2, unit_cost: 900 }], []).spread, 0)
  assert.deepEqual(tripTotals([], []), { goods: 0, units: 0, extras: 0, spread: 0 })
})

test('blank and garbage amounts are ignored rather than counted as NaN', () => {
  const result = tripTotals([{ quantity: 1, unit_cost: 100 }], [{ amount: '' }, { amount: null }, { amount: 'abc' }])
  assert.equal(result.extras, 0)
  assert.equal(result.spread, 0)
})
