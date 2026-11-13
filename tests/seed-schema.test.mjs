import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'

// supabase/schema/columns.tsv is a partial paste of the live project's
// information_schema (alerts … expenses). These tests pin the parts of
// seed_data.sql that the real schema can actually verify, so a later edit
// cannot quietly reintroduce a NOT NULL violation in those tables.
const seed = await fs.readFile(new URL('../supabase/seed_data.sql', import.meta.url), 'utf8')
const dump = await fs.readFile(new URL('../supabase/schema/columns.tsv', import.meta.url), 'utf8')

const schema = new Map()
for (const line of dump.split('\n')) {
  if (!line.trim()) continue
  const [table, column, nullable, def, type] = line.split('\t')
  if (!schema.has(table)) schema.set(table, new Map())
  schema.get(table).set(column, {
    nullable: nullable === 'YES',
    defaultKnown: def !== 'UNKNOWN',
    hasDefault: def !== 'UNKNOWN' && def !== 'NULL' && def !== '',
    type,
  })
}

// INSERT INTO public.<table>(<cols>) for the tables the dump covers.
function insertColumns(table) {
  const re = new RegExp(`INSERT INTO public\\.${table}\\s*\\(([^)]*)\\)`, 'gi')
  return [...seed.matchAll(re)].map(m => m[1].split(',').map(c => c.trim()))
}

test('the recorded schema is usable and covers expenses', () => {
  assert.ok(schema.has('expenses'))
  assert.ok(schema.get('expenses').has('receipt_url'))
  assert.ok(schema.size >= 13, 'expected the full a…e slice')
})

// The suppliers insert sits inside an EXECUTE block chosen by an
// information_schema check, because sources disagree on whether
// suppliers.store_id exists. Columns named only there are deliberate.
const guardedBlock = (() => {
  const start = seed.indexOf("table_name = 'suppliers'")
  return start > -1 ? seed.slice(start, start + 2500) : ''
})()

test('every column the seed names in a covered table really exists', () => {
  for (const [table, columns] of schema) {
    for (const list of insertColumns(table)) {
      for (const column of list) {
        // insertColumns() only sees static INSERTs, so a genuinely absent
        // column is still a failure here unless it is guarded at runtime.
        const guarded = table === 'suppliers' && column === 'store_id' &&
          guardedBlock.includes("column_name = 'store_id'")
        if (guarded) continue
        assert.ok(schema.get(table).has(column),
          `${table}.${column}: named in the seed but absent from the recorded schema`)
      }
    }
  }
})

test('the seed supplies every NOT NULL column the real schema requires', () => {
  for (const [table, columns] of schema) {
    for (const list of insertColumns(table)) {
      for (const [column, meta] of columns) {
        if (meta.nullable) continue
        // A NOT NULL column with a known default may be omitted; where the dump
        // omits the default we cannot prove either way, so it is not asserted.
        if (meta.defaultKnown && meta.hasDefault) continue
        if (!meta.defaultKnown) continue
        assert.ok(list.includes(column),
          `${table}.${column}: NOT NULL with no default, but the insert omits it`)
      }
    }
  }
})

test('the seed never writes an explicit NULL into a NOT NULL column', () => {
  // expenses and credits are the covered tables the seed writes with a SELECT.
  const blocks = [...seed.matchAll(/INSERT INTO public\.(expenses|credits)\s*\(([^)]*)\)([\s\S]*?);/g)]
  assert.ok(blocks.length >= 2, 'expected the expenses and credits inserts')
  for (const [, table, columnList, rest] of blocks) {
    const columns = columnList.split(',').map(c => c.trim())
    const select = rest.match(/SELECT\s+([\s\S]*?)\n\s*FROM/i)
    if (!select) continue
    const exprs = select[1].split(',').map(e => e.trim())
    if (exprs.length !== columns.length) continue // covered by the checker script
    columns.forEach((column, i) => {
      const meta = schema.get(table)?.get(column)
      if (!meta || meta.nullable) return
      assert.ok(!/^NULL$/i.test(exprs[i]),
        `${table}.${column}: NOT NULL but the insert writes NULL`)
    })
  }
})

test('pending_collections.receipt_url is never NULL in the seed', () => {
  // Not in the provided dump, but a 23502 already proved it is NOT NULL there.
  // Position matters: receipt_url is the 5th column of that INSERT, and a
  // SELECT list is what supplies it.
  const source = withoutComments.slice(withoutComments.indexOf('INSERT INTO public.pending_collections'))
  const body = source.slice(0, source.indexOf(';'))
  const columns = body.slice(body.indexOf('(') + 1, body.indexOf(')')).split(',').map(c => c.trim())
  const index = columns.indexOf('receipt_url')
  assert.ok(index > -1, 'receipt_url should be in the column list')

  const select = body.slice(body.indexOf('SELECT') + 'SELECT'.length, body.indexOf('\n    FROM'))
  const exprs = select.split(',').map(e => e.trim())
  assert.equal(exprs.length, columns.length, 'expression count should match the column list')
  assert.ok(!/^NULL$/i.test(exprs[index]),
    'receipt_url is NOT NULL, so the seed must not write NULL there')
  assert.ok(exprs[index].includes('example.com'), 'receipt_url should carry a placeholder URL')
})

// Comments explain the old value ('synced') by name, so they must be stripped
// before asserting: matching them would fail on the very comment that documents
// the fix.
const withoutComments = seed.split('\n').map(line => {
  let quote = false
  for (let i = 0; i < line.length; i++) {
    if (line[i] === "'") quote = !quote
    else if (!quote && line[i] === '-' && line[i + 1] === '-') return line.slice(0, i)
  }
  return line
}).join('\n')

test('sales are seeded with a status the CHECK constraint accepts', () => {
  const block = withoutComments.slice(withoutComments.indexOf('INSERT INTO public.sales'))
  const body = block.slice(0, block.indexOf(';'))
  assert.ok(!/'synced'/.test(body), "sales.status must not be 'synced'")
  assert.ok(/'completed'/.test(body), "sales.status should be 'completed'")
})

test('the seed uses no RPCs', () => {
  assert.equal([...seed.matchAll(/PERFORM\s+public\.engine_\w+/g)].length, 0)
})
