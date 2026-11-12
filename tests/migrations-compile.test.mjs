import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const MIGRATIONS = path.join(ROOT, 'supabase', 'migrations')

// A migration is only useful if PostgreSQL can compile it. The failures this
// guards against are invisible to a text assertion and to `next build`:
//   * a variable used but never declared (`"bad_product" is not a known variable`)
//   * a mismatched parenthesis inside a function body
// Both surface only when the server compiles the function, which is what
// pglast's PL/pgSQL parser does here. If pglast is not installed the test skips
// rather than failing CI on a missing optional tool.
const PYTHON = process.env.PYTHON || 'python3'
const PGLAST_PATH = process.env.PGLAST_PATH || '/tmp/pgl'

function havePglast () {
  try {
    execFileSync(PYTHON, ['-c', 'import pglast'], {
      env: { ...process.env, PYTHONPATH: PGLAST_PATH },
      stdio: 'ignore',
    })
    return true
  } catch { return false }
}

const SCRIPT = `
import sys
from pglast import parse_sql, parser

def fail(msg):
    print(msg); sys.exit(1)

for path in sys.argv[1:]:
    sql = open(path, encoding='utf-8').read()
    # Whole-file syntax: catches a stray paren between statements.
    try:
        parse_sql(sql)
    except Exception as e:
        fail(f"{path}: {str(e).splitlines()[0]}")

    # Every function body, compiled the way the server compiles it.
    for part in sql.split('CREATE OR REPLACE FUNCTION ')[1:]:
        name = part.split('(')[0].strip()
        end = part.find('$$;')
        if end == -1:
            fail(f"{path}: {name} has no closing $$;")
        stmt = 'CREATE OR REPLACE FUNCTION ' + part[:end + 3]
        try:
            parser.parse_plpgsql_json(stmt)
        except Exception as e:
            fail(f"{path}: {name}: {str(e).splitlines()[0]}")
`

test('every migration compiles as PostgreSQL, function bodies included', async (t) => {
  if (!havePglast()) {
    t.skip('pglast not installed; install with: pip install pglast')
    return
  }
  const files = (await fs.readdir(MIGRATIONS)).filter(f => f.endsWith('.sql')).sort()
  assert.ok(files.length > 10, 'expected the migration history')

  let output = ''
  try {
    execFileSync(PYTHON, ['-c', SCRIPT, ...files.map(f => path.join(MIGRATIONS, f))], {
      env: { ...process.env, PYTHONPATH: PGLAST_PATH },
      encoding: 'utf8',
    })
  } catch (err) {
    output = err.stdout || err.message
  }
  assert.equal(output.trim(), '', `migration did not compile:\n${output}`)
})

test('the looks migration declares every variable it uses', async () => {
  // The exact reported failure: engine_save_look used bad_product after a
  // rename removed its declaration. A plain text check is kept as a fast
  // signal that does not depend on pglast being installed.
  const sql = await fs.readFile(path.join(MIGRATIONS, '202611120012_looks_feature.sql'), 'utf8')
  const body = sql.slice(sql.indexOf('FUNCTION public.engine_save_look'),
    sql.indexOf('FUNCTION public.engine_set_look_active'))
  const declare = body.slice(body.indexOf('DECLARE'), body.indexOf('BEGIN'))
  for (const variable of ['bad_product', 'bad_variant', 'saved', 'clean', 'el']) {
    if (!new RegExp(`\\b${variable}\\b`).test(body.slice(body.indexOf('BEGIN')))) continue
    assert.match(declare, new RegExp(`\\b${variable}\\b`), `${variable} is used but not declared`)
  }
})
