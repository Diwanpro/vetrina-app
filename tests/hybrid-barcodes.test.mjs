import test from 'node:test'
import assert from 'node:assert/strict'
import 'fake-indexeddb/auto'
import { barcodeCellKey, validateBarcode, productBarcodePayload, resolveHybridBarcode, variantStock, barcodeLabels } from '../lib/barcode/hybrid.js'
import { saveCatalog, localGet, catalogKey, persistLocalSale } from '../lib/local-db.js'

const ctx = () => ({ user: { id: crypto.randomUUID() }, staffId: 'staff', tenantId: 'A', storeId: 'branch' })
function fixture() {
 const variant = { id: 'uuid-variant', color: 'black', size: 'M', min_price: 0, inventory: [{store_id:'branch',quantity:10,reserved_qty:7}] }
 const records = [
  { id:'model',tenant_id:'A',product_id:'p',variant_id:null,barcode:'000MODEL',barcode_type:'model' },
  { id:'v',tenant_id:'A',product_id:'p',variant_id:variant.id,barcode:'000VARIANT',barcode_type:'variant' },
  { id:'alias',tenant_id:'A',product_id:'p',variant_id:variant.id,barcode:'ALIAS',barcode_type:'variant' },
 ]
 return { variant, records, product:{id:'p',tenant_id:'A',name:'shirt',product_variants:[variant],product_barcodes:records} }
}
test('model resolves as model even with one variant; variant aliases and UUID resolve precisely', () => {
 const {product,variant}=fixture()
 assert.equal(resolveHybridBarcode([product],'000MODEL','A').type,'model')
 for(const code of ['000VARIANT','ALIAS',variant.id]) assert.equal(resolveHybridBarcode([product],code,'A').variant.id,variant.id)
 assert.equal(variantStock(variant,'branch'),3)
 assert.equal(variantStock(variant,'elsewhere'),0)
 assert.throws(()=>resolveHybridBarcode([product],'000MODEL','B'))
})
test('online lookup is authoritative; deleted aliases cannot resurrect from stale catalog', () => {
 const {product,variant,records}=fixture()
 assert.throws(()=>resolveHybridBarcode([product],'ALIAS','A',null))
 assert.equal(resolveHybridBarcode([product],variant.id,'A',null).variant.id,variant.id)
 assert.equal(resolveHybridBarcode([product],'000MODEL','A',records[0]).type,'model')
 assert.throws(()=>resolveHybridBarcode([product],'000MODEL','A',{...records[0],tenant_id:'B'}))
})
test('legacy cache fallback is supported only when no registry snapshot exists', () => {
 const {product,variant}=fixture(); const old={...product};delete old.product_barcodes
 old.product_variants=[{...variant,barcode:'LEGACY'}]
 assert.equal(resolveHybridBarcode([old],'LEGACY','A').type,'variant')
 assert.throws(()=>resolveHybridBarcode([{...old,product_barcodes:[]}],'LEGACY','A'))
})
test('registry matches take precedence over UUID-shaped input; no first-match ambiguity', () => {
 const {product,variant,records}=fixture(); const row={...records[0],barcode:variant.id}
 assert.equal(resolveHybridBarcode([product],variant.id,'A',row).type,'model')
 assert.throws(()=>resolveHybridBarcode([{...product,product_barcodes:[row,row]}],variant.id,'A'),/ملتبس/)
})
test('atomic product payload keeps exact text, optional fields, and rejects duplicate model/variant codes', () => {
 const cells=[{color:'red',size:'M',qty:2},{color:'red',size:'L',qty:3}]
 const map={[barcodeCellKey('red','M')]:'00123'}
 const payload=productBarcodePayload(cells,'MODEL',map)
 assert.equal(payload.modelBarcodes[0].barcode,'MODEL')
 assert.equal(payload.variants[0].barcodes[0].barcode,'00123')
 assert.deepEqual(payload.variants[1].barcodes,[])
 assert.equal(payload.variants[1].quantity,3)
 assert.deepEqual(productBarcodePayload(cells,'',{}).modelBarcodes,[])
 assert.throws(()=>productBarcodePayload(cells,'00123',map),/مكرر/)
 assert.throws(()=>productBarcodePayload(cells,'',{...map,[barcodeCellKey('red','L')]:'00123'}),/مكرر/)
 assert.throws(()=>validateBarcode('bad code'))
 assert.throws(()=>validateBarcode('a'.repeat(65)))
 assert.equal(validateBarcode('a'.repeat(64)).length,64)
})
test('printing modes use registry aliases; absent model does not silently print a variant', () => {
 const {product,variant,records}=fixture()
 assert.equal(barcodeLabels(product,[variant],records,'model').length,1)
 assert.equal(barcodeLabels(product,[variant],records,'variant').length,2)
 assert.equal(barcodeLabels(product,[variant],records,'both').length,3)
 assert.deepEqual(barcodeLabels(product,[variant],[],'model'),[])
 assert.equal(barcodeLabels(product,[variant],[],'variant')[0].barcode,variant.id)
})
test('offline IndexedDB retains model and alias mapping and enforces net10/7 Draft sale', async () => {
 const context=ctx();const {product}=fixture()
 await saveCatalog(context,[product])
 const cached=await localGet(catalogKey(context))
 assert.equal(resolveHybridBarcode(cached,'000MODEL','A').type,'model')
 assert.equal(resolveHybridBarcode(cached,'ALIAS','A').type,'variant')
 const item={variantId:'uuid-variant',name:'shirt',price:100,originalPrice:100,qty:4}
 await assert.rejects(persistLocalSale(context,[item],'cash'),/يوجد حجز/)
 const row=await persistLocalSale(context,[{...item,qty:3}],'cash')
 assert.equal(row.confirmation,'draft')
 assert.equal(variantStock((await localGet(catalogKey(context)))[0].product_variants[0],'branch'),0)
})
