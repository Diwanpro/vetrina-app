import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { generateDescription, generateProductName, validateSmartEntry, smartSpecsFromForm, SMART_REQUIRED_FIELDS, FABRIC_OPTIONS, STYLE_OPTIONS } from '../lib/product-entry.js'
import { oosMessage, oosStatus, canReplenishFromMaster, INVENTORY_SCOPES } from '../lib/inventory-alerts.js'
const read = p => fs.readFile(new URL(`../${p}`, import.meta.url), 'utf8')
const valid = { imagePreview: 'https://example.com/a.jpg', cells: [{ color: 'أحمر', size: 'M', qty: 2 }] }
test('only four merchant-required fields, no name price category or description', () => {
 assert.deepEqual(SMART_REQUIRED_FIELDS, ['image','color','sizes','quantity'])
 assert.equal(validateSmartEntry(valid), null)
 assert.ok(validateSmartEntry({ cells: valid.cells }))
 assert.ok(validateSmartEntry({ imagePreview: 'image', cells: [] }))
 for (const bad of [{color:'',size:'M',qty:1},{color:'أحمر',size:'',qty:1},{color:'أحمر',size:'M',qty:-1},{color:'أحمر',size:'M',qty:1.2}]) assert.ok(validateSmartEntry({...valid,cells:[bad]}))
})
test('Arabic description and name use category, fabric, color and style', () => {
 const specs=smartSpecsFromForm({category:'ملابس',subcategory:'فساتين سهرة',fabric:'الحرير',style:'فاخر'},valid.cells,{storeType:'womens'})
 const description=generateDescription(specs)
 for(const word of ['فستان سهرة','الحرير','أحمر','فاخر','M']) assert.ok(description.includes(word))
 assert.ok(generateProductName(specs).includes('فستان'))
 assert.ok(generateDescription({}).length>20)
 assert.ok(FABRIC_OPTIONS.length>2 && STYLE_OPTIONS.length>2)
})
test('OOS decision priority and exact Arabic messages', () => {
 assert.notEqual(INVENTORY_SCOPES.MASTER, INVENTORY_SCOPES.BRANCH)
 assert.equal(oosStatus({masterQuantity:2,otherBranchName:'شرق'}),'master')
 assert.ok(canReplenishFromMaster({master_quantity:2}))
 assert.equal(canReplenishFromMaster({masterQuantity:0}),false)
 assert.equal(oosStatus({otherBranchName:'شرق'}),'other_branch')
 assert.equal(oosMessage({otherBranchName:'شرق',size:'M'}),'متوفر في فرع شرق بمقاس M')
 assert.equal(oosMessage({}),'المنتج غير متوفر نهائياً، سيتم إخفاؤه من المتجر حتى إعادة التعبئة')
})
test('form uses camera capture and routes barcode scans to search or entry', async () => {
 const s=await read('app/dashboard/_screens/products.js')
 assert.match(s,/capture="environment"/)
 assert.match(s,/scanning === 'search'/)
 assert.match(s,/validateSmartEntry/)
 assert.match(s,/generateDescription\(specs\)/)
 assert.doesNotMatch(s,/<select\b/)
 assert.doesNotMatch(s,/if \(!form.name.trim\(\)/)
})
test('warehouse transfer is atomic, tenant scoped, locked, manager authorized', async () => {
 const s=await read('supabase/migrations/202611130020_smart_inventory.sql')
 assert.match(s,/FOR UPDATE/)
 assert.match(s,/inventory.quantity\+excluded.quantity/)
 assert.match(s,/PERFORM public.engine_staff/g)
 assert.match(s,/ENABLE ROW LEVEL SECURITY/)
 assert.match(s,/OLD.quantity>0/)
 assert.match(s,/ALTER PUBLICATION supabase_realtime ADD TABLE public.inventory/)
 assert.doesNotMatch(s,/(?:ALTER TABLE|UPDATE|INSERT INTO|DELETE FROM) public.orders\b/i)
})
