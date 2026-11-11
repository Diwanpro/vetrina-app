import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'

// Regression guard for the failure:
//   column "created_at" does not exist
// caused by CREATE TABLE IF NOT EXISTS being a no-op on an existing table while
// an index later referenced a column that was never added.

const load = async name => fs.readFile(new URL(`../supabase/migrations/${name}`, import.meta.url), 'utf8')
const sql = await load('202611100023_credit_payments_idempotent.sql')
const old = await load('202611100022_credit_payments_expenses.sql')

const pos = needle => {
  const index = sql.indexOf(needle)
  assert.ok(index > -1, `missing: ${needle}`)
  return index
}

test('the migration never relies on CREATE TABLE to add columns', () => {
  // Every table that may already exist must add its columns explicitly.
  for (const column of ['credit_id', 'store_id', 'shift_id', 'amount', 'created_by', 'request_id', 'created_at']) {
    assert.match(sql, new RegExp(`ALTER TABLE public\\.credit_payments ADD COLUMN IF NOT EXISTS ${column}\\b`),
      `credit_payments.${column} must be added with ADD COLUMN IF NOT EXISTS`)
  }
})

test('created_at exists before any index references it', () => {
  const column = pos('ADD COLUMN IF NOT EXISTS created_at')
  const index = pos('credit_payments_credit ON public.credit_payments(credit_id, created_at DESC)')
  assert.ok(column < index, 'created_at must be added before the index that uses it')
})

test('every index is created with IF NOT EXISTS and after its table columns', () => {
  // Comments quote the original broken statements, so strip them first.
  const executable = sql.split('\n').filter(line => !line.trim().startsWith('--')).join('\n')
  const indexes = executable.match(/CREATE (?:UNIQUE )?INDEX [^\n]+/g) || []
  assert.ok(indexes.length >= 4)
  for (const statement of indexes) {
    assert.match(statement, /CREATE (?:UNIQUE )?INDEX IF NOT EXISTS/, `not idempotent: ${statement}`)
  }
  // The unique request index must come after the request_id column.
  assert.ok(pos('ADD COLUMN IF NOT EXISTS request_id') < pos('UNIQUE INDEX IF NOT EXISTS credit_payments_request'))
})

test('created_at is backfilled before it becomes NOT NULL', () => {
  const update = pos('UPDATE public.credit_payments SET created_at = now() WHERE created_at IS NULL')
  const notNull = pos('ALTER COLUMN created_at SET NOT NULL')
  assert.ok(update < notNull, 'existing rows must be filled before the NOT NULL constraint')
})

test('constraints are guarded and only added when no row violates them', () => {
  // Each foreign key is preceded by a check for offending rows.
  assert.match(sql, /conname = 'credit_payments_credit_id_fkey'[\s\S]{0,400}?NOT EXISTS \(SELECT 1 FROM public\.credit_payments p WHERE p\.credit_id IS NOT NULL/)
  assert.match(sql, /conname = 'credit_payments_store_id_fkey'[\s\S]{0,400}?NOT EXISTS/)
  assert.match(sql, /conname = 'expenses_deleted_by_fkey'[\s\S]{0,400}?NOT EXISTS/)
})

test('an unexpected NOT NULL column is reported instead of failing later at runtime', () => {
  assert.match(sql, /is_nullable = 'NO' AND column_default IS NULL/)
  assert.match(sql, /RAISE EXCEPTION 'credit_payments has NOT NULL columns without a default/)
})

test('the shift drawer column and expenses columns are also added idempotently', () => {
  assert.match(sql, /ALTER TABLE public\.shifts ADD COLUMN IF NOT EXISTS total_credit_payments bigint NOT NULL DEFAULT 0/)
  for (const column of ['category', 'deleted_at', 'deleted_by']) {
    assert.match(sql, new RegExp(`ALTER TABLE public\\.expenses ADD COLUMN IF NOT EXISTS ${column}\\b`))
  }
  assert.ok(pos('ADD COLUMN IF NOT EXISTS category') < pos('INDEX IF NOT EXISTS expenses_category'))
})

test('the receipts bucket creation cannot fail on a re-run', () => {
  assert.match(sql, /INSERT INTO storage\.buckets[\s\S]*?ON CONFLICT \(id\) DO NOTHING/)
})

test('all nine functions are redefined and match the original implementation', () => {
  const names = [...sql.matchAll(/CREATE OR REPLACE FUNCTION public\.(\w+)/g)].map(m => m[1])
  const expected = ['engine_credit_payment', 'engine_customer_ledger', 'engine_close_shift', 'engine_delete_expense',
    'engine_accounting', 'engine_journal', 'engine_set_employee_active', 'engine_receipts_access', 'engine_record_expense_v2']
  assert.deepEqual(names.sort(), expected.sort())

  const extract = source => Object.fromEntries([...source.matchAll(/CREATE OR REPLACE FUNCTION public\.(\w+)/g)].map(m => {
    const start = m.index
    return [m[1], source.slice(start, source.indexOf('END $$;', start) + 'END $$;'.length)]
  }))
  const before = extract(old)
  const after = extract(sql)
  for (const name of expected) {
    assert.equal(after[name], before[name], `${name} body must be unchanged by the repair`)
  }
})

test('the repair keeps the soft-delete filter that 021 depends on', () => {
  assert.match(sql, /x\.deleted_at IS NULL/)
})

test('the file is a single well-formed script', () => {
  assert.equal(sql.split('$$').length % 2, 1, 'unbalanced dollar-quoted blocks')
  assert.equal(sql.includes('$$$'), false)
})
