import test from 'node:test'
import assert from 'node:assert/strict'
import { availableStock } from '../lib/stock-availability.js'
import { readFile } from 'node:fs/promises'
test('10 total / 7 reserved permits 3 and rejects 4', () => {
 const available = availableStock({quantity:10,reserved_qty:7})
 assert.equal(available,3); assert.equal(4<=available,false); assert.equal(3<=available,true)
 assert.equal(availableStock({quantity:10}),0)
 assert.equal(availableStock({quantity:10,reserved_qty:null}),10)
 assert.equal(availableStock({quantity:2,reserved_qty:7}),0)
})
test('server patch protects sale and transfer and serializes reservation release', async () => {
 const sql = await readFile('supabase/migrations/202611130023_inventory_reservations.sql','utf8')
 assert.match(sql,/quantity - coalesce\(reserved_qty,0\).*FOR UPDATE/)
 assert.match(sql,/engine_transfer/); assert.match(sql,/inventory_reservation_bounds/)
 assert.match(sql,/u.role = ''manager''/)
 assert.match(sql,/ORDER BY i.variant_id FOR UPDATE/)
})
