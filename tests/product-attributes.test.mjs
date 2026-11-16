import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizeColorComponents as normalize, colorLabel, sizeLabel } from '../lib/product-attributes.js'
import { sizesForType, filledSizeCells } from '../lib/product-sizes.js'
import { productBarcodePayload, barcodeLabels, resolveHybridBarcode, variantStock } from '../lib/barcode/hybrid.js'
test('ONE_SIZE is one persisted size with a translated display only',()=>{
 assert.deepEqual(sizesForType('one_size'),['ONE_SIZE']);assert.equal(sizeLabel('ONE_SIZE'),'مقاس موحد');assert.equal(sizeLabel('M'),'M')
 assert.deepEqual(filledSizeCells({black:{ONE_SIZE:3,M:9}},sizesForType('one_size')),[{color:'black',size:'ONE_SIZE',qty:3}])
})
test('color normalization is order invariant and preserves structured boundaries',()=>{
 assert.deepEqual(normalize([' أسود ','أبيض']),normalize(['أبيض','أسود']))
 assert.notDeepEqual(normalize(['a / b']),normalize(['a','b']))
 for(const x of [[],null,['a','a'],['a',' a '],[''],['\t'],[null],[1],['a'.repeat(41)],Array(7).fill('a')]) assert.throws(()=>normalize(x))
 assert.equal(colorLabel(['أبيض','أسود']),'أبيض / أسود')
})
test('composite ONE_SIZE barcode still identifies exactly one unchanged variant',()=>{
 const parts=normalize(['أسود','أبيض']),color=colorLabel(parts)
 const payload=productBarcodePayload([{color,color_components:parts,size:'ONE_SIZE',qty:3}],'MODEL',{})
 assert.deepEqual(payload.variants[0].color_components,parts)
 const v={id:'v',color,color_components:parts,size:'ONE_SIZE',inventory:[{store_id:'s',quantity:10,reserved_qty:7}]}
 const p={id:'p',tenant_id:'t',name:'bag',product_variants:[v]};const b={id:'b',product_id:'p',variant_id:'v',barcode_type:'variant',barcode:'CODE'}
 assert.equal(resolveHybridBarcode([p],'CODE','t',b).variant.id,'v');assert.equal(variantStock(v,'s'),3)
 assert.match(barcodeLabels(p,[v],[b],'variant')[0].detail,/مقاس موحد/)
 assert.equal(resolveHybridBarcode([p],'v','t',null).variant.id,'v')
})
test('ONE_SIZE is translated in both thermal text widths and HTML, without changing receipt identity',async()=>{
 const {normalizeReceipt,receiptLines,receiptHtml}=await import('../lib/printing/receipt.js')
 for(const width of ['58mm','80mm']) {
  const receipt=normalizeReceipt({width,items:[{name:'bag',color:'black / white',size:'ONE_SIZE',qty:1,price:100}]})
  assert.equal(receipt.items[0].size,'ONE_SIZE')
  assert.match(JSON.stringify(receiptLines(receipt)),/مقاس موحد/)
  assert.match(receiptHtml(receipt),/مقاس موحد/)
 }
})
