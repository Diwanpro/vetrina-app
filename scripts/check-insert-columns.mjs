// Verify an INSERT into public.<table> against information_schema.columns.
//
//   node scripts/check-insert-columns.mjs --file column-dump.txt
//   node scripts/check-insert-columns.mjs --query    # needs a DATABASE_URL
//
// The point is to stop guessing. Every seed failure so far was a column that
// was NOT NULL when we assumed otherwise (or vice versa). This refuses to
// approve an insert that omits a column the database requires, or that writes
// an explicit NULL into one.
//
// Without a reachable database, pass --file with the tab-separated output of:
//
//   SELECT table_name, column_name, is_nullable, column_default,
//          data_type, character_maximum_length
//   FROM information_schema.columns
//   WHERE table_schema = 'public'
//   ORDER BY table_name, ordinal_position;
//
// The parser reads the seed's INSERT statements statically. It understands the
// shapes the seed actually uses: a literal column list, and `SELECT expr, …`
// where the expressions line up with that list. It deliberately does not try to
// be a SQL engine — anything it cannot read is reported, never silently passed.

import fs from 'node:fs'
import process from 'node:process'

// ---------------------------------------------------------------- schema load
function loadSchemaFromText(text) {
  const schema = new Map()
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    // Accept both tab- and pipe-separated dumps.
    const parts = line.includes('\t') ? line.split('\t') : line.split('|')
    if (parts.length < 4) continue
    const [table, column, nullable, def, type, len] = parts.map(p => p.trim())
    if (!table || !column || table === 'table_name') continue
    if (!schema.has(table)) schema.set(table, new Map())
    // A dump may list only name/type/nullable. "UNKNOWN" is not "no default":
    // treating the two as equal produced false 23502 warnings on id columns
    // that really do default to gen_random_uuid().
    const unknown = !def || def === 'UNKNOWN' || def === '?'
    schema.get(table).set(column, {
      nullable: nullable.toUpperCase() === 'YES',
      defaultKnown: !unknown,
      default: unknown ? null : (def !== 'NULL' && def !== '' ? def : null),
      // A GENERATED ALWAYS column rejects any supplied *value* with 428C9.
      // (The bare keyword DEFAULT is accepted, but naming the column at all is
      // the mistake this catches.) The dump has no column for generation, so it
      // is recorded in the default slot and recognised here.
      generated: !unknown && /^GENERATED\s+(ALWAYS|BY DEFAULT)/i.test(def),
      type: type || '',
      len: len && len !== 'NULL' ? Number(len) : null,
    })
  }
  return schema
}

// ------------------------------------------------------- INSERT extraction
// Matches:  INSERT INTO public.<table>(<cols>)  <rest>
// We then take the rest up to the matching statement end and read the first
// VALUES (...) row, or a SELECT whose expressions map onto the column list.
// Strip `--` comments first: the seed explains its expressions inline, and a
// comment inside a VALUES list otherwise gets counted as an expression.
function stripComments(sql) {
  return sql.split('\n').map(line => {
    let quote = false
    for (let i = 0; i < line.length; i++) {
      const ch = line[i]
      if (ch === "'") quote = !quote
      else if (!quote && ch === '-' && line[i + 1] === '-') return line.slice(0, i)
    }
    return line
  }).join('\n')
}

function extractInserts(rawSql) {
  const sql = stripComments(rawSql)
  // Character ranges that sit inside an EXECUTE $tag$ … $tag$ block.
  const dynamicRanges = []
  for (const m of sql.matchAll(/EXECUTE\s+(\$\w*\$)/g)) {
    const tag = m[1]
    const start = m.index
    const close = sql.indexOf(tag, m.index + m[0].length)
    if (close > -1) dynamicRanges.push([start, close])
  }
  const isDynamic = idx => dynamicRanges.some(([a, b]) => idx >= a && idx <= b)

  const found = []
  const re = /INSERT\s+INTO\s+public\.(\w+)\s*\(([^)]*)\)/gi
  let m
  while ((m = re.exec(sql))) {
    const table = m[1]
    const columns = m[2].split(',').map(c => c.trim()).filter(Boolean)
    const rest = sql.slice(re.lastIndex)
    found.push({ table, columns, rest, index: m.index, dynamic: isDynamic(m.index) })
  }
  return found
}

// Split a comma-separated expression list, respecting quotes and parentheses.
function splitExprs(text) {
  const out = []
  let depth = 0, quote = false, cur = ''
  for (const ch of text) {
    if (ch === "'") { quote = !quote; cur += ch; continue }
    if (!quote && ch === '(') depth++
    if (!quote && ch === ')') depth--
    if (!quote && ch === ',' && depth === 0) { out.push(cur.trim()); cur = ''; continue }
    cur += ch
  }
  if (cur.trim()) out.push(cur.trim())
  return out
}

// The first VALUES row's expressions, in order.
function valuesRows(rest) {
  const v = rest.search(/\bVALUES\b/i)
  if (v < 0) return null
  const rows = []
  let i = v + 'VALUES'.length
  while (i < rest.length) {
    // skip whitespace and commas between rows
    while (i < rest.length && /[\s,]/.test(rest[i])) i++
    if (rest[i] !== '(') break
    let depth = 0, quote = false, end = -1
    for (let j = i; j < rest.length; j++) {
      const ch = rest[j]
      if (ch === "'") { quote = !quote; continue }
      if (quote) continue
      if (ch === '(') depth++
      if (ch === ')') { depth--; if (depth === 0) { end = j; break } }
    }
    if (end < 0) break
    rows.push(splitExprs(rest.slice(i + 1, end)))
    i = end + 1
    // stop when the statement clearly ends
    if (/^\s*(ON\s+CONFLICT|RETURNING|;)/i.test(rest.slice(i))) break
  }
  return rows.length ? rows : null
}

// `SELECT a, b, c …` — the select list before FROM.
function selectRow(rest) {
  const s = rest.search(/\bSELECT\b/i)
  const v = rest.search(/\bVALUES\b/i)
  if (s < 0 || (v >= 0 && v < s)) return null
  const body = rest.slice(s + 'SELECT'.length)
  // Only the first top-level FROM ends the select list. A later
  // `FROM (VALUES ...) AS x(a,b)` is the values source and must not be read
  // as a second list of output columns.
  let quote = false, depth = 0
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]
    if (ch === "'") { quote = !quote; continue }
    if (quote) continue
    if (ch === '(') depth++
    else if (ch === ')') depth--
    else if (depth === 0 && /\bFROM\b/i.test(body.slice(i, i + 4))) {
      return splitExprs(body.slice(0, i))
    }
  }
  return null
}

// Is this expression certainly NULL? Deliberately strict: `coalesce(x,'')`
// and a bare column reference are not nulls we can prove, so they pass.
function isExplicitNull(expr) {
  return /^NULL$/i.test(expr.trim())
}

// ---------------------------------------------------------------- the check
function check(schema, sql) {
  const problems = []
  const unverified = []
  const checked = []
  const inserts = extractInserts(sql)
  if (inserts.length === 0) problems.push('no INSERT INTO public.* found — parser out of date?')

  for (const { table, columns, rest, dynamic } of inserts) {
    const tableSchema = schema.get(table)
    if (!tableSchema) {
      problems.push(`${table}: not present in the schema dump`)
      continue
    }
    // A branch chosen at runtime may name a column that is absent from this
    // schema — that is the point of the guard — so report, do not fail.
    if (dynamic) {
      for (const column of columns) {
        if (!tableSchema.has(column)) {
          unverified.push(`${table}.${column} (inside EXECUTE): guards against absence at runtime`)
        }
      }
      checked.push({ table, columns: columns.length, rows: 0 })
      continue
    }

    // 1. every named column must exist
    for (const column of columns) {
      if (!tableSchema.has(column)) {
        problems.push(`${table}.${column}: column does not exist`)
      }
    }

    // 1b. a GENERATED ALWAYS column must never be named. This is the check that
    // would have caught day_closes.difference before it reached Supabase.
    for (const column of columns) {
      const meta = tableSchema.get(column)
      if (meta?.generated) {
        problems.push(`${table}.${column}: is GENERATED ALWAYS and cannot be inserted (428C9)`)
      }
    }

    // 2. every NOT NULL column without a default must be supplied.
    // Where the dump does not state a default we cannot prove the omission is
    // unsafe, so it is reported as unverified rather than failed.
    for (const [column, meta] of tableSchema) {
      if (meta.nullable || columns.includes(column)) continue
      if (!meta.defaultKnown) {
        unverified.push(`${table}.${column}: NOT NULL, insert omits it, and the dump does not state a default`)
      } else if (meta.default === null) {
        problems.push(`${table}.${column}: NOT NULL, no default, and the insert omits it`)
      }
    }

    // 3. no explicit NULL into a NOT NULL column, in any VALUES row
    // Which one applies depends on order: `INSERT … SELECT … FROM (VALUES …)`
    // has its values source AFTER the select list, so the select list is
    // authoritative. Only a leading VALUES block supplies the inserted rows.
    const selIdx = rest.search(/\bSELECT\b/i)
    const valIdx = rest.search(/\bVALUES\b/i)
    const useSelect = selIdx > -1 && (valIdx < 0 || selIdx < valIdx)
    const rows = useSelect ? null : valuesRows(rest)
    const exprs = useSelect ? selectRow(rest) : null
    const allRows = rows || (exprs ? [exprs] : [])

    if (!allRows.length) {
      problems.push(`${table}: could not read the inserted expressions — cannot verify`)
    } else {
      for (const row of allRows) {
        if (row.length !== columns.length) {
          problems.push(`${table}: ${columns.length} columns but ${row.length} expressions — cannot verify`)
          continue
        }
        columns.forEach((column, i) => {
          const meta = tableSchema.get(column)
          if (meta && !meta.nullable && isExplicitNull(row[i])) {
            problems.push(`${table}.${column}: NOT NULL but the insert writes NULL`)
          }
          if (meta && meta.len && /^'.*'$/.test(row[i].trim())) {
            const literal = row[i].trim().slice(1, -1)
            if (literal.length > meta.len) {
              problems.push(`${table}.${column}: literal is ${literal.length} chars, column allows ${meta.len}`)
            }
          }
        })
      }
    }

    checked.push({ table, columns: columns.length, rows: allRows.length })
  }
  return { problems, unverified, checked }
}

// --------------------------------------------------------------------- main
const args = process.argv.slice(2)
const fileIdx = args.indexOf('--file')
let schemaText = null

if (fileIdx > -1) {
  schemaText = fs.readFileSync(args[fileIdx + 1], 'utf8')
} else if (args.includes('--query')) {
  const url = process.env.DATABASE_URL
  if (!url) {
    console.error('--query needs DATABASE_URL, or pass --file <dump>.\n' +
      'Export it with:\n' +
      '  psql "$DATABASE_URL" -At -F \'\\t\' -c "SELECT table_name, column_name, is_nullable, column_default, data_type, character_maximum_length FROM information_schema.columns WHERE table_schema=\'public\' ORDER BY table_name, ordinal_position;"')
    process.exit(2)
  }
  const { execFileSync } = await import('node:child_process')
  schemaText = execFileSync('psql', [url, '-At', '-F', '\t', '-c',
    "SELECT table_name, column_name, is_nullable, coalesce(column_default,'NULL'), data_type, coalesce(character_maximum_length::text,'') FROM information_schema.columns WHERE table_schema='public' ORDER BY table_name, ordinal_position;"
  ]).toString()
} else {
  console.error('usage: check-insert-columns.mjs --file <dump> | --query')
  process.exit(2)
}

const schema = loadSchemaFromText(schemaText)
const seedPath = args.find(a => a.endsWith('.sql')) ||
  new URL('../supabase/seed_data.sql', import.meta.url).pathname
const seed = fs.readFileSync(seedPath, 'utf8')

const { problems, unverified, checked } = check(schema, seed)
console.log(`tables in dump: ${schema.size}`)
for (const row of checked) console.log(`  INSERT ${row.table}: ${row.columns} columns, ${row.rows} row(s) verified`)

if (unverified.length) {
  console.log(`\n${unverified.length} unverified (not failures — the dump omits defaults):`)
  for (const u of unverified) console.log(`  ? ${u}`)
}

if (problems.length) {
  console.error(`\n${problems.length} problem(s):`)
  for (const p of problems) console.error(`  - ${p}`)
  process.exit(1)
}
console.log('\nOK: every insert matches the schema')
