import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { PGlite } from '@electric-sql/pglite'
const migration = await readFile('supabase/migrations/202611230001_manual_stock_legacy_movements.sql','utf8')
const original = await readFile('supabase/migrations/202611120003_stock_movements_and_offers.sql','utf8')
const oldFunction = original.slice(original.indexOf('CREATE OR REPLACE FUNCTION public.engine_add_stock_manual('), original.indexOf('-- --------------------------------------------------------- offers RPCs'))
const tenant='11111111-1111-4111-8111-111111111111', store='22222222-2222-4222-8222-222222222222', variant='33333333-3333-4333-8333-333333333333'
const request='44444444-4444-4444-8444-444444444444'
async function setup(legacy) {
 const db = new PGlite()
 await db.exec(`
 CREATE TABLE stores(id uuid primary key,tenant_id uuid);
 CREATE TABLE products(id uuid primary key,tenant_id uuid);
 CREATE TABLE product_variants(id uuid primary key, product_id uuid,cost_price_avg numeric);
 CREATE TABLE inventory(id uuid default gen_random_uuid(),store_id uuid,variant_id uuid,quantity integer,updated_at timestamptz,unique(store_id,variant_id));
 CREATE TABLE inventory_movements(id uuid default gen_random_uuid(),tenant_id uuid,store_id uuid,variant_id uuid,kind text,quantity_delta integer,unit_cost numeric,request_id uuid unique,created_by uuid${legacy ? ",movement_type text not null check(movement_type in ('sale','purchase','transfer','return','adjustment','initial_stock')),quantity_change integer not null" : ''});
 CREATE FUNCTION engine_staff(uuid,uuid) RETURNS uuid LANGUAGE plpgsql AS $$ BEGIN IF current_setting('test.deny',true)='true' THEN RAISE EXCEPTION 'denied'; END IF; RETURN '55555555-5555-4555-8555-555555555555'::uuid; END $$;
 INSERT INTO stores VALUES('${store}','${tenant}');
 INSERT INTO products VALUES('${tenant}','${tenant}');
 INSERT INTO product_variants VALUES('${variant}','${tenant}',100);
 INSERT INTO inventory(store_id,variant_id,quantity) VALUES('${store}','${variant}',10);
 `)
 return db
}
function call(q=5,c=160,r=request,v=variant){ return `SELECT engine_add_stock_manual('${store}','${tenant}','${v}',${q},${c},'${r}') AS cost` }
for(const legacy of [true,false]) test(`manual stock writes real SQL and preserves idempotency (${legacy?'legacy':'clean'} schema)`,async()=>{
 const db=await setup(legacy)
 try {
  if(legacy){
   await db.exec(oldFunction)
   await assert.rejects(db.query(call()),/movement_type/)
   assert.equal((await db.query('select quantity from inventory')).rows[0].quantity,10)
  }
  await db.exec(migration); await db.exec(migration)
  assert.equal(Number((await db.query(call())).rows[0].cost),120)
  await db.query(call())
  assert.equal((await db.query('select quantity from inventory')).rows[0].quantity,15)
  const rows=(await db.query('select * from inventory_movements')).rows
  assert.equal(rows.length,1); assert.equal(rows[0].movement_type,'adjustment'); assert.equal(rows[0].kind,'adjustment')
  assert.equal(rows[0].quantity_change,5); assert.equal(rows[0].quantity_delta,5)
  await assert.rejects(db.query(call(0)),/الكمية/)
  await assert.rejects(db.query(call(1,-1)),/التكلفة/)
  await assert.rejects(db.query(call(1,10,'66666666-6666-4666-8666-666666666666',tenant)),/المقاس/)
  await db.exec("SET test.deny='true'")
  await assert.rejects(db.query(call()),/denied/)
 } finally {await db.close()}
})
