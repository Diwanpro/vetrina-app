// In-memory PostgreSQL only. Auth and storage metadata are fixtures; the branch,
// receipt and expense functions are taken from the actual migrations.
import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID as uuid } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { PGlite } from '@electric-sql/pglite'

const migration = file => readFile(new URL(`../supabase/migrations/${file}.sql`, import.meta.url), 'utf8')
async function priorFunction(file, name) {
  const sql = await migration(file)
  const start = sql.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`)
  const end = sql.indexOf('END $$;', start)
  assert.ok(start >= 0 && end > start, `missing fixture dependency: ${name}`)
  return sql.slice(start, end + 'END $$;'.length)
}

test('expense RPC upgrade from the existing signatures (isolated PGlite)', async t => {
  const db = new PGlite()
  t.after(() => db.close())
  const tenant = uuid(), otherTenant = uuid(), store = uuid(), sibling = uuid(), foreign = uuid()
  const actors = Object.fromEntries(['employee', 'manager', 'owner'].map(role => [role, { id: uuid(), auth: uuid() }]))
  const { employee, manager, owner } = actors
  await db.exec(`
    CREATE ROLE authenticated; CREATE ROLE anon;
    CREATE SCHEMA storage; CREATE SCHEMA auth;
    CREATE TABLE storage.objects(bucket_id text, name text, PRIMARY KEY(bucket_id, name));
    CREATE TABLE tenants(id uuid PRIMARY KEY, is_active boolean DEFAULT true, subscription_end_date timestamptz);
    CREATE TABLE stores(id uuid PRIMARY KEY, tenant_id uuid REFERENCES tenants);
    CREATE TABLE users(id uuid PRIMARY KEY, auth_id uuid UNIQUE, role text, tenant_id uuid REFERENCES tenants,
      store_id uuid REFERENCES stores, is_active boolean DEFAULT true);
    CREATE TABLE expenses(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), store_id uuid NOT NULL REFERENCES stores,
      amount integer NOT NULL, description text, category text, receipt_url text, created_by uuid REFERENCES users,
      status text, request_id uuid UNIQUE);
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
      SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    CREATE FUNCTION public.current_staff() RETURNS public.users LANGUAGE sql STABLE SECURITY DEFINER AS $$
      SELECT u FROM public.users u WHERE u.auth_id = auth.uid() AND coalesce(u.is_active, true) LIMIT 1 $$;
  `)
  await db.query('INSERT INTO tenants(id) VALUES ($1), ($2)', [tenant, otherTenant])
  await db.query('INSERT INTO stores VALUES ($1,$4), ($2,$4), ($3,$5)', [store, sibling, foreign, tenant, otherTenant])
  for (const [role, actor] of Object.entries(actors)) {
    await db.query('INSERT INTO users(id,auth_id,role,tenant_id,store_id) VALUES ($1,$2,$3,$4,$5)', [actor.id, actor.auth, role, tenant, store])
  }
  await db.exec(await priorFunction('202611100004_phase3', 'engine_validate'))
  await db.exec(await priorFunction('202611100008_commercial', 'engine_receipt_access'))
  await db.exec(await priorFunction('202611100008_commercial', 'engine_record_expense'))
  await db.exec('REVOKE ALL ON FUNCTION engine_record_expense(uuid,integer,text,text,uuid) FROM PUBLIC, anon;')
  await db.exec(await migration('202611100010_expense_author'))
  await db.exec(await priorFunction('202611100023_credit_payments_idempotent', 'engine_record_expense_v2'))

  // Named arguments reflect the two JSON key sets sent by the dashboard, not a superuser call.
  async function record(actor, endpoint, options = {}) {
    const staff = endpoint === 'for_staff'
    const args = { p_store: store, p_amount: 25, p_description: 'مصروف', p_receipt: null, p_request: uuid(),
      ...(staff ? { p_staff: actor.id } : { p_category: 'نقل' }), ...options }
    const named = Object.keys(args).map((name, i) => `${name} => $${i + 1}`).join(', ')
    return db.transaction(async tx => {
      await tx.exec('SET LOCAL ROLE authenticated')
      await tx.query("SELECT set_config('request.jwt.claim.sub', $1, true)", [actor.auth])
      const { rows } = await tx.query(`SELECT public.engine_record_expense_${endpoint}(${named}) AS id`, Object.values(args))
      return rows[0].id
    })
  }
  const count = async () => (await db.query('SELECT count(*)::int AS n FROM expenses')).rows[0].n
  const saved = async id => (await db.query('SELECT * FROM expenses WHERE id=$1', [id])).rows[0]
  const legacyRequest = { p_request: uuid() }
  const legacyId = await record(employee, 'for_staff', legacyRequest)
  const sql = await migration('202611180001_expense_role_boundary')
  await db.exec(sql)
  await db.exec(sql) // safe to replay; no overload with overlapping defaults

  const own = `${tenant}/${store}/${employee.auth}/own.pdf`
  const peer = `${tenant}/${store}/${manager.auth}/peer.pdf`
  const branchReceipt = `${tenant}/${store}/branch.pdf`
  const wrongBucket = `${tenant}/${store}/${employee.auth}/elsewhere.pdf`
  await db.query(`INSERT INTO storage.objects VALUES
    ('expense-receipts',$1), ('expense-receipts',$2), ('receipts',$3), ('receipts',$4)`, [own, peer, branchReceipt, wrongBucket])

  await t.test('both staff signatures and v2 require authentication; the bare writer stays private', async () => {
    const { rows } = await db.query(`SELECT proname, pronargs, pronargdefaults,
      has_function_privilege('authenticated', oid, 'EXECUTE') AS signed_in,
      has_function_privilege('anon', oid, 'EXECUTE') AS anonymous
      FROM pg_proc WHERE pronamespace='public'::regnamespace
      AND proname IN ('engine_record_expense','engine_record_expense_for_staff','engine_record_expense_v2')
      ORDER BY proname, pronargs`)
    assert.deepEqual(rows.map(r => [r.proname, r.pronargs, r.pronargdefaults, r.signed_in, r.anonymous]), [
      ['engine_record_expense', 5, 0, false, false], ['engine_record_expense_for_staff', 6, 0, true, false],
      ['engine_record_expense_for_staff', 7, 0, true, false], ['engine_record_expense_v2', 6, 0, true, false],
    ])
  })
  await t.test('six-argument top-bar requests still save for every role and replay a pre-upgrade row', async () => {
    assert.equal(await record(employee, 'for_staff', legacyRequest), legacyId)
    for (const actor of Object.values(actors)) {
      const row = await saved(await record(actor, 'for_staff'))
      assert.equal(row.category, null)
      assert.equal(row.created_by, actor.id)
    }
  })
  await t.test('the employee category is normalized and inserted atomically with their own receipt', async () => {
    const data = { p_request: uuid(), p_receipt: own, p_category: '  نقل  ' }
    const before = await count()
    const id = await record(employee, 'for_staff', data)
    const row = await saved(id)
    assert.deepEqual([row.store_id, row.created_by, row.category, row.receipt_url, row.status], [store, employee.id, 'نقل', own, 'approved'])
    assert.equal(await record(employee, 'for_staff', data), id)
    await assert.rejects(record(employee, 'for_staff', { ...data, p_category: 'صيانة' }), /طلب مكرر/)
    assert.equal(await count(), before + 1)
    assert.equal((await saved(id)).category, 'نقل')
  })
  await t.test('category is optional and limited to 80 characters after trimming', async () => {
    for (const value of [null, '  ', 'ن'.repeat(80)]) {
      const row = await saved(await record(employee, 'for_staff', { p_category: value }))
      assert.equal(row.category, value?.trim() || null)
    }
    const before = await count()
    await assert.rejects(record(employee, 'for_staff', { p_category: 'ن'.repeat(81) }), /التصنيف طويل/)
    assert.equal(await count(), before)
  })
  await t.test('staff author, branch, amount and receipt checks still fail closed without a write', async () => {
    const before = await count()
    for (const extra of [{}, { p_category: 'نقل' }]) {
      for (const [input, message] of [
        [{ p_staff: manager.id }, /تغير حساب/], [{ p_store: sibling }, /غير مصرح/],
        [{ p_store: foreign }, /غير مصرح/], [{ p_amount: 0 }, /مبلغاً موجباً/],
        [{ p_receipt: peer }, /المرفق غير صالح/], [{ p_receipt: branchReceipt }, /المرفق غير صالح/],
        [{ p_receipt: wrongBucket }, /المرفق غير صالح/], [{ p_receipt: `${own}.missing` }, /المرفق غير صالح/],
      ]) await assert.rejects(record(employee, 'for_staff', { ...extra, ...input }), message)
    }
    assert.equal(await count(), before)
  })
  await t.test('v2 denies an employee before processing even an existing request', async () => {
    const before = await count()
    for (const data of [legacyRequest, { p_receipt: branchReceipt }]) {
      await assert.rejects(record(employee, 'v2', data), { code: '42501' })
    }
    assert.equal(await count(), before)
  })
  await t.test('v2 preserves manager branch and owner tenant scope and the original receipt bucket', async () => {
    for (const actor of [manager, owner]) {
      const row = await saved(await record(actor, 'v2', { p_receipt: branchReceipt }))
      assert.deepEqual([row.created_by, row.category, row.receipt_url], [actor.id, 'نقل', branchReceipt])
      await assert.rejects(record(actor, 'v2', { p_store: foreign }), /غير مصرح/)
      await assert.rejects(record(actor, 'v2', { p_receipt: own }), /المرفق غير صالح/)
    }
    await assert.rejects(record(manager, 'v2', { p_store: sibling }), /غير مصرح/)
    assert.equal((await saved(await record(owner, 'v2', { p_store: sibling }))).store_id, sibling)
  })
})
