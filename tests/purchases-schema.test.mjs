import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'

// `public.purchases` is not created by any migration — it came from the base
// schema — so nothing in this repo would have caught a typo in the column list
// of an INSERT into it. This file records the real table (read from
// information_schema on the live project) and pins every writer against it.
//
// If a column is added, add it here. If one is renamed, this test is what tells
// you which RPCs and screens still use the old name.
const PURCHASES_COLUMNS = {
  id: { nullable: false, default: 'gen_random_uuid()' },
  store_id: { nullable: false, default: null },
  supplier_name: { nullable: true, default: null },
  total_amount: { nullable: true, default: 0 },
  status: { nullable: true, default: "'received'::text" },
  created_by: { nullable: true, default: null },
  created_at: { nullable: true, default: 'now()' },
  tenant_id: { nullable: true, default: null },
  supplier_id: { nullable: true, default: null },
  request_id: { nullable: true, default: null },
  request_items: { nullable: true, default: null },
  description: { nullable: true, default: null },
}

const files = await fs.readdir(new URL('../supabase/migrations/', import.meta.url))
const sqlFiles = files.filter(file => file.endsWith('.sql')).sort()
const migrationText = (await Promise.all(sqlFiles.map(file =>
  fs.readFile(new URL(`../supabase/migrations/${file}`, import.meta.url), 'utf8'))
)).join('\n')

// Every `INSERT INTO public.purchases(a, b, c)` in the migrations, with the
// column list split up.
function purchaseInserts() {
  return [...migrationText.matchAll(/INSERT INTO public\.purchases\s*\(([^)]*)\)/gi)]
    .map(match => match[1].split(',').map(name => name.trim()).filter(Boolean))
}

test('every purchase insert names columns the table actually has', () => {
  const inserts = purchaseInserts()
  assert.ok(inserts.length >= 2, 'expected engine_receive_purchase and engine_save_trip')
  for (const columns of inserts) {
    for (const column of columns) {
      assert.ok(
        Object.hasOwn(PURCHASES_COLUMNS, column),
        `INSERT into purchases uses "${column}", which is not a column of the table`,
      )
    }
  }
})

test('every purchase insert supplies the required columns', () => {
  // store_id is NOT NULL with no default: an insert that omits it cannot work.
  const required = Object.entries(PURCHASES_COLUMNS)
    .filter(([, meta]) => !meta.nullable && meta.default === null)
    .map(([name]) => name)
  for (const columns of purchaseInserts()) {
    for (const column of required) {
      assert.ok(columns.includes(column), `INSERT into purchases must supply "${column}"`)
    }
  }
})

test('every purchase insert scopes the row to a tenant', () => {
  // tenant_id is nullable, so an insert that omits it still *succeeds* — and
  // then the row is invisible forever: the RLS policy filters
  // purchases.tenant_id, and engine_purchases filters tenant_id = p_tenant.
  // A silent, successful write that nobody can read is the worst outcome, so
  // this is asserted explicitly rather than left to the nullable column.
  for (const columns of purchaseInserts()) {
    assert.ok(columns.includes('tenant_id'),
      'an insert into purchases must set tenant_id or the row is invisible to RLS')
    assert.ok(columns.includes('store_id'),
      'an insert into purchases must set store_id')
  }
})

test('the trip RPC writes a purchase the purchases screen can read', () => {
  const source = migrationText.slice(migrationText.indexOf('FUNCTION public.engine_save_trip'))
  const body = source.slice(0, source.indexOf('$$;'))
  // purchases.js selects these through engine_purchases; the trip row must fill
  // them or the history shows blanks.
  for (const column of ['supplier_name', 'total_amount', 'created_at']) {
    assert.ok(body.includes(column), `engine_save_trip must set ${column} on the purchase row`)
  }
})

test('the purchases screen only reads columns that exist', async () => {
  const screen = await fs.readFile(new URL('../app/dashboard/_screens/purchases.js', import.meta.url), 'utf8')
  // Anchor on the engine_purchases call: the file has other selects (suppliers)
  // whose columns belong to a different table.
  const rpc = screen.indexOf("rpc('engine_purchases'")
  assert.ok(rpc > -1, 'purchases.js should call engine_purchases')
  const selected = screen.slice(rpc).match(/\.select\('([^']+)'\)/)
  assert.ok(selected, 'purchases.js should still select explicit columns')
  const columns = selected[1].split(',').map(name => name.trim()).filter(name => name && !name.includes('('))
  for (const column of columns) {
    assert.ok(Object.hasOwn(PURCHASES_COLUMNS, column),
      `purchases.js selects "${column}", which is not a column of purchases`)
  }
})
