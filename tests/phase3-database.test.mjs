// Isolated PostgreSQL WASM, never Supabase/Live. Schema and auth dependencies
// are boundary fixtures, so this proves SQL behavior, not production RLS.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { PGlite } from '@electric-sql/pglite'
test('Phase3 migration and atomic RPC execute in isolated PostgreSQL with full rollback on invalid inputs',async()=>{
 const db=new PGlite()
 try {
 await db.exec(`
 CREATE ROLE anon; CREATE ROLE authenticated;
 CREATE TABLE products(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid,name text,base_price integer,description text,category text,subcategory text,brand text,images text[],image_url text,external_video_url text,is_active boolean);
 CREATE TABLE product_variants(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),product_id uuid REFERENCES products(id),color text,size text,sku text,min_price integer,cost_price_avg numeric,barcode text);
 CREATE TABLE inventory(store_id uuid,variant_id uuid REFERENCES product_variants(id),quantity integer);
 CREATE TABLE product_barcodes(id uuid DEFAULT gen_random_uuid(),tenant_id uuid,product_id uuid,variant_id uuid,barcode text UNIQUE,barcode_type text,barcode_source text,is_primary boolean);
 CREATE SEQUENCE demo_codes;
 CREATE FUNCTION engine_validate(uuid,uuid,text[]) RETURNS void LANGUAGE plpgsql AS $$ BEGIN IF $1 <> '00000000-0000-0000-0000-000000000001'::uuid THEN RAISE EXCEPTION 'fixture access denied'; END IF; END $$;
 CREATE FUNCTION engine_generate_barcodes(uuid,uuid,integer) RETURNS text[] LANGUAGE sql AS $$ SELECT ARRAY['TEST' || nextval('demo_codes')::text] $$;
 INSERT INTO products(id,tenant_id,name) VALUES('00000000-0000-0000-0000-000000000003','00000000-0000-0000-0000-000000000002','legacy');
 INSERT INTO product_variants(product_id,color,size,barcode) VALUES('00000000-0000-0000-0000-000000000003','old / label','M','OLD');
 `)
 await db.exec('BEGIN;'+await fs.readFile('supabase/migrations/202611130027_product_attributes.sql','utf8')+'COMMIT;')
 const before=await db.query('SELECT * FROM product_variants WHERE barcode=\'OLD\'')
 assert.equal(before.rows[0].color_components,null)
 const create=variants=>db.query(`SELECT engine_create_product_atomic('00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000002',$1::jsonb,$2::jsonb) id`,[JSON.stringify({name:'bag',base_price:0}),JSON.stringify(variants)])
 await create([{color:'ignored client label',color_components:['black',' white '],size:'ONE_SIZE',quantity:3}])
 const actual=await db.query("SELECT color,color_components,size FROM product_variants WHERE size='ONE_SIZE'")
 assert.deepEqual(actual.rows,[{color:'black / white',color_components:['black','white'],size:'ONE_SIZE'}])
 await create([{color:'legacy request',size:'M',quantity:1}])
 const counts=()=>db.query('SELECT (SELECT count(*)::int FROM products) p,(SELECT count(*)::int FROM product_variants) v,(SELECT count(*)::int FROM inventory) i,(SELECT count(*)::int FROM product_barcodes) b')
 const snapshot=(await counts()).rows
 for(const parts of [[],['a','a'],[''],[null],[1],null,['a'.repeat(41)],['a\tb'],['a','b','c','d','e','f','g']]) {
  await assert.rejects(create([{color_components:parts,size:'ONE_SIZE',quantity:1}]))
  assert.deepEqual((await counts()).rows,snapshot)
 }
 await assert.rejects(create([{color_components:['a','b'],size:'ONE_SIZE',quantity:1},{color_components:['b','a'],size:'ONE_SIZE',quantity:2}]))
 await assert.rejects(create([{color:'a',size:'M',quantity:1,barcodes:[{barcode:'DUP'}]},{color:'b',size:'M',quantity:2,barcodes:[{barcode:'DUP'}]}]))
 assert.deepEqual((await counts()).rows,snapshot)
 await assert.rejects(db.exec("UPDATE product_variants SET color_components=ARRAY['z','a'] WHERE barcode='OLD'"))
 assert.deepEqual((await db.query("SELECT * FROM product_variants WHERE barcode='OLD'")).rows,before.rows)
 } finally { await db.close() }
})
