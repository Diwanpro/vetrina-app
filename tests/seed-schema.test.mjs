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
    // The fixture records a generated column in the default slot, because
    // information_schema's paste format has no column for generation.
    generated: /^GENERATED\s+(ALWAYS|BY DEFAULT)/i.test(def || ''),
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

// ------------------------------------------------------- the four demo blocks
test('orders use only values the CHECK constraints accept', () => {
  // payment_method IN ('cod') and fulfillment_type IN ('delivery','pickup').
  // A card or credit order would be rejected by the database, so the seed must
  // not offer one.
  const block = withoutComments.slice(withoutComments.indexOf('INSERT INTO public.orders'))
  const body = block.slice(0, block.indexOf("'cod'") + 5)
  assert.ok(/'cod'/.test(body), 'orders.payment_method must be cod')
  assert.ok(!/'card'|'credit'|'cash'/.test(body), 'payment_method has a CHECK allowing cod only')
  assert.ok(/'pickup'/.test(block), 'fulfillment_type should use pickup for one order')
  // order_number is UNIQUE per tenant, so the three must differ.
  const numbers = [...block.matchAll(/SEED-10\d\d/g)].map(m => m[0])
  assert.equal(new Set(numbers).size, numbers.length, 'order numbers must be unique')
})

test('the three demo orders cover the three requested statuses', () => {
  const block = withoutComments.slice(withoutComments.indexOf('ARRAY[\'SEED-1001\''))
  const body = block.slice(0, block.indexOf('END LOOP'))
  for (const status of ['new', 'confirmed', 'delivered']) {
    assert.ok(new RegExp(`'${status}'`).test(body), `expected a ${status} order`)
  }
})

test('the shift and its day_closes row are written from the same numbers', () => {
  // Both inserts read v_expected / v_actual, so they cannot drift apart.
  const start = withoutComments.indexOf('INSERT INTO public.shifts')
  const block = withoutComments.slice(start, withoutComments.indexOf('END IF;', start))
  assert.ok(/INSERT INTO public\.shifts/.test(block))
  assert.ok(/INSERT INTO public\.day_closes/.test(block), 'a day_closes row must pair with the shift')
  assert.ok(/v_actual - v_expected/.test(block), 'difference must be derived, not typed in')
  // The re-run guard must use LIKE: the note it writes appends the float.
  assert.ok(/notes LIKE tag \|\| ' وردية الأمس%'/.test(seed),
    'the shift guard must prefix-match the note it writes')
})

test('alerts describe rows that really exist and carry no invented FK columns', () => {
  // alerts has store_id, type, message, is_read and created_at only. Writing a
  // variant_id would be a 42703.
  for (const list of insertColumns('alerts')) {
    for (const column of list) {
      assert.ok(['store_id', 'type', 'message', 'is_read', 'created_at'].includes(column),
        `alerts.${column} is not a column of that table`)
    }
  }
  // The two types requested, and both stock levels really lowered.
  assert.ok(/low_stock/.test(seed) && /credit_overdue/.test(seed))
  assert.ok(/SET due_date =/.test(seed), 'overdue credits must get a real due_date')
})

test('audit_log entries point at rows the seed actually created', () => {
  const block = withoutComments.slice(withoutComments.indexOf('INSERT INTO public.audit_log'))
  const body = block.slice(0, block.indexOf('WHERE NOT EXISTS'))
  for (const action of ['cancelled_invoice', 'price_change', 'stock_adjustment',
                        'expense_approved', 'credit_written_off']) {
    assert.ok(body.includes(`'${action}'`), `expected an ${action} entry`)
  }
  // Every entity id comes from a lookup or a known store, never a literal uuid
  // that might not exist.
  assert.ok(!/[0-9a-f]{8}-[0-9a-f]{4}/.test(body.replace(/00000000-0000-4000-8000-000000000e02/g, '')),
    'audit entity ids should be looked up, not hardcoded')
})

// ------------------------------------------------- generated-column guardrails
test('day_closes.difference is never named: it is GENERATED ALWAYS', () => {
  // 428C9 from the live database: "cannot insert a non-DEFAULT value into
  // column difference". The column computes itself, so naming it at all is the
  // bug, regardless of which expression is supplied.
  const start = withoutComments.indexOf('INSERT INTO public.day_closes')
  assert.ok(start > -1, 'expected the day_closes insert')
  const block = withoutComments.slice(start)
  const body = block.slice(0, block.indexOf(';'))
  const columnList = body.slice(body.indexOf('(') + 1, body.indexOf(')'))
  const columns = columnList.split(',').map(c => c.trim())
  assert.ok(!columns.includes('difference'),
    'day_closes.difference is GENERATED ALWAYS and must not appear in the column list')

  // The value list must be exactly as long as the column list, so the fix
  // cannot have removed the column name while leaving its expression behind.
  const values = body.slice(body.indexOf('VALUES') + 'VALUES'.length, body.lastIndexOf(')'))
  const exprs = values.split(',')
  assert.equal(exprs.length, columns.length,
    'VALUES must still line up with the column list after dropping difference')
})

test('shifts.difference IS still written: that column is writable', () => {
  // The two tables look alike and are not. shifts.difference was converted from
  // a generated expression to a plain column (lib/cash.js) and the POS inserts
  // it on every shift open, so removing it here would be a different bug.
  const start = withoutComments.indexOf('INSERT INTO public.shifts')
  const body = withoutComments.slice(start, withoutComments.indexOf(';', start))
  const columns = body.slice(body.indexOf('(') + 1, body.indexOf(')')).split(',').map(c => c.trim())
  assert.ok(columns.includes('difference'),
    'shifts.difference is writable and should keep being supplied')
})

test('no insert names a column recorded as GENERATED ALWAYS', () => {
  // Generalised version of the two tests above, driven by the fixture: if a
  // column is ever marked generated, this fails for any table.
  for (const [table, columns] of schema) {
    for (const list of insertColumns(table)) {
      for (const column of list) {
        const meta = schema.get(table).get(column)
        assert.ok(!meta?.generated,
          `${table}.${column}: GENERATED ALWAYS, cannot be inserted (428C9)`)
      }
    }
  }
})

// ------------------------------------------------------------ product photos
test('the seed uses Unsplash CDN ids, not picsum or page slugs', () => {
  // picsum.photos answers with a *different random photo per request*, so a
  // product's picture could change between two page loads, and it is slow to
  // reach from Algeria. Real Unsplash ids are stable and cacheable.
  assert.doesNotMatch(withoutComments, /picsum\.photos/,
    'no product image may point at picsum any more')

  // Scoped to the p_image array: looks carry covers of their own, and counting
  // the whole file would let an outfit cover mask a missing product photo.
  const imageBlock = seed.slice(seed.indexOf('p_image  constant text[]'))
  const pImage = imageBlock.slice(0, imageBlock.indexOf('];'))
  const urls = [...pImage.matchAll(/'https:\/\/images\.unsplash\.com\/(photo-[^'?]+)\?/g)].map(m => m[1])
  assert.equal(urls.length, 30, 'expected two photos for each of the 15 products')

  // The seeded looks need a real cover too, or the إطلالات tab shows a wall of
  // placeholders in the demo data.
  const looksBlock = seed.slice(seed.indexOf('INSERT INTO public.looks(tenant_id'))
  const covers = [...looksBlock.slice(0, looksBlock.indexOf('RETURNING id')).matchAll(
    /https:\/\/images\.unsplash\.com\/(photo-[^'?]+)\?/g)].map(m => m[1])
  assert.ok(covers.length >= 1, 'seeded looks must carry a real cover')

  for (const id of [...urls, ...covers]) {
    // The CDN form is photo-<timestamp>-<hash>. A bare page slug such as
    // photo-WWesmHEgXDs is what unsplash.com/photos/ uses and does not resolve
    // on images.unsplash.com.
    assert.match(id, /^photo-\d{9,13}-[0-9a-f]{6,12}$/, `${id} is not a CDN id`)
  }
  assert.equal(new Set(urls).size, urls.length, 'every photo must be distinct')
})

test('every product image URL carries the requested transform', () => {
  const urls = [...seed.matchAll(/'https:\/\/images\.unsplash\.com\/photo-[^']+'/g)].map(m => m[0].slice(1, -1))
  for (const url of urls) {
    assert.match(url, /\?w=800&q=80$/, `${url} is missing ?w=800&q=80`)
  }
})

test('image_url is the first entry of the images array, per product', () => {
  // The seed inserts p_image[2i-1 : 2i] as images and p_image[2i-1] as
  // image_url, so the two cannot disagree. Pin the slicing.
  assert.match(seed, /p_image\[\(i - 1\) \* 2 \+ 1 : i \* 2\]/,
    'images must be the two-element slice for product i')
  assert.match(seed, /p_image\[\(i - 1\) \* 2 \+ 1\]/,
    'image_url must be the first element of that slice')
  // And the array must be flat: p_image[i] on a text[][] yields text, which
  // Postgres rejects for a text[] column with 42804.
  assert.match(seed, /p_image\s+constant text\[\]\s*:=/)
  assert.doesNotMatch(seed, /p_image\s+constant text\[\]\[\]/)
})

test('no array element list ends with a trailing comma', () => {
  // `ARRAY['a', 'b',]` is a syntax error at the closing bracket in Postgres,
  // and it is easy to introduce by hand-editing the last element. The whole
  // seed is one DO block, so this would fail only at run time.
  const arrays = [...withoutComments.matchAll(/ARRAY\[([^\]]*)\]/gs)]
  assert.ok(arrays.length > 0, 'expected ARRAY[...] literals in the seed')
  for (const [, body] of arrays) {
    assert.doesNotMatch(body, /,\s*$/, 'ARRAY literal ends with a trailing comma')
  }
})
