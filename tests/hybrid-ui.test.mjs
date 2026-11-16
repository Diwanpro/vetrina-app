import test, { afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { JSDOM } from 'jsdom'
import fs from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { hybridUIModules } from './fixtures/hybrid-ui-modules.mjs'

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://local.test/dashboard/products/barcodes?product=p' })
for (const key of ['window','document','HTMLElement','HTMLInputElement','Node','Event','MouseEvent','KeyboardEvent','MutationObserver','localStorage']) globalThis[key] = dom.window[key]
Object.defineProperty(globalThis,'navigator',{value:dom.window.navigator, configurable:true})
globalThis.IS_REACT_ACT_ENVIRONMENT = true
globalThis.requestAnimationFrame = callback => setTimeout(callback,0)
globalThis.cancelAnimationFrame = clearTimeout
URL.createObjectURL = () => 'blob:test-image'
HTMLElement.prototype.scrollIntoView = () => {}
const React = await import('react')
const { render, fireEvent, screen, waitFor, cleanup } = await import('@testing-library/react')
afterEach(cleanup)
const root = process.cwd()
const context = {tenantId:'A',storeId:'branch',staffId:'staff',storeType:'mens',role:'owner',user:{id:'auth'},stores:[{id:'branch'}],storeIds:['branch']}
const variant = {id:'uuid-variant',color:'أسود',size:'M',barcode:'VARIANT01',min_price:0,inventory:[{store_id:'branch',quantity:10,reserved_qty:7}]}
const records = [
 {id:'m',tenant_id:'A',product_id:'p',variant_id:null,barcode:'MODEL001',barcode_type:'model'},
 {id:'v',tenant_id:'A',product_id:'p',variant_id:variant.id,barcode:'VARIANT01',barcode_type:'variant'},
]
const product = {id:'p',tenant_id:'A',name:'قميص الاختبار',is_active:true,base_price:100,product_variants:[variant],product_barcodes:records}
let state
function reset() {
 state={context:{...context},products:[structuredClone(product)],registry:structuredClone(records),rpcCalls:[],queries:[],printed:[],rpcError:null,uploadError:null,prints:0}
 function query(table) {
  const q={ table,filters:{},select(){return this},eq(k,v){this.filters[k]=v;return this},order(){return this},range(){return this},limit(){return this},in(){return this},
   result(single=false){
    state.queries.push({table,filters:{...this.filters}})
    let data=table==='products'?state.products:table==='product_variants'?state.products.flatMap(p=>p.product_variants):table==='product_barcodes'?state.registry:table==='stores'?[{id:'branch',name:'متجر الاختبار'}]:[]
    data=data.filter(row=>Object.entries(this.filters).every(([k,v])=>k.includes('.') || k==='product_id'&&table==='product_variants' || row[k]===v))
    return {data:single?(data[0]||null):data,error:null}
   },single(){return Promise.resolve(this.result(true))},maybeSingle(){return Promise.resolve(this.result(true))},then(resolve,reject){return Promise.resolve(this.result()).then(resolve,reject)}}
  return q
 }
 state.supabase={from:query,async rpc(name,args){state.rpcCalls.push({name,args});return name==='engine_create_product_atomic'?{data:state.rpcError?null:'created-product',error:state.rpcError}:{data:[],error:null}},storage:{from(){return {async upload(){return {error:state.uploadError}},getPublicUrl(){return {data:{publicUrl:'https://example.com/product.jpg'}}}}}}}
 globalThis.__hybridUI=state
 window.print=()=>state.prints++
}
reset()
const mocks = hybridUIModules
const imports={}
for(const [name,file] of Object.entries({POS:'app/dashboard/pos/page.js',Products:'app/dashboard/_screens/products.js',Printing:'app/dashboard/products/barcodes/page.js'})) {
 const outfile=path.join(root,'.cache/hybrid-ui',name+'.mjs')
 await build({entryPoints:[path.join(root,file)],outfile,bundle:true,platform:'node',format:'esm',jsx:'automatic',loader:{'.js':'jsx'},external:['react','react-dom','react-dom/client','react/jsx-runtime'],plugins:[{name:'test-backend',setup(b){
  b.onResolve({filter:/.*/},args=>Object.hasOwn(mocks,args.path)?{path:args.path,namespace:'mock'}:args.path.startsWith('@/')?{path:path.join(root,args.path.slice(2)+'.js')}:undefined)
  b.onLoad({filter:/.*/,namespace:'mock'},args=>({contents:mocks[args.path],loader:'jsx',resolveDir:root}))
 }}]})
 imports[name]=(await import(pathToFileURL(outfile))).default
}
async function scan(code) {
 const input=screen.getByPlaceholderText('امسح الباركود أو ابحث عن منتج...')
 input.focus()
 for(const key of code) fireEvent.keyDown(window,{key})
 fireEvent.keyDown(window,{key:'Enter'})
 await waitFor(()=>assert.ok(state.queries.some(q=>q.table==='product_barcodes'&&q.filters.barcode===code)))
}
async function choose(label, option) {
 fireEvent.click(screen.getByRole('button',{name:label}))
 await waitFor(()=>screen.getByRole('option',{name:option}))
 fireEvent.click(screen.getByRole('option',{name:option}))
}
test('POS actual HID handler opens model picker for a single variant and waits for explicit color/size confirmation', async()=>{
 reset();render(React.createElement(imports.POS))
 await screen.findByText('قميص الاختبار')
 await scan('MODEL001')
 const confirm=await screen.findByRole('button',{name:'تأكيد التركيبة وإضافتها للسلة'})
 assert.equal(confirm.disabled,true)
 await choose('لون الموديل','أسود')
 assert.equal(confirm.disabled,true)
 await choose('مقاس الموديل','M · المتاح 3')
 assert.equal(confirm.disabled,false)
 fireEvent.click(confirm)
 await waitFor(()=>assert.equal(!!screen.queryByRole('dialog'),false))
 assert.ok(state.queries.some(q=>q.table==='product_barcodes'&&q.filters.tenant_id==='A'))
})
test('POS variant barcode adds directly and fourth scan rejects net10/7 without opening picker',async()=>{
 reset();render(React.createElement(imports.POS));await screen.findByText('قميص الاختبار')
 for(let i=0;i<4;i++){await scan('VARIANT01');await new Promise(r=>setTimeout(r,5))}
 await screen.findByText('الكمية المتاحة غير كافية (يوجد حجز لطلبات أخرى)')
 assert.equal(!!screen.queryByRole('dialog'),false)
})
test('printing real screen switches model/variant/both using CustomSelect and never writes a barcode',async()=>{
 reset();render(React.createElement(imports.Printing))
 await waitFor(()=>assert.ok(state.printed.includes('VARIANT01')))
 await choose('نوع الباركود للطباعة','باركود الموديل')
 await waitFor(()=>assert.ok(state.printed.includes('MODEL001')))
 assert.equal(document.querySelectorAll('svg[data-code]').length,1)
 await choose('نوع الباركود للطباعة','كلاهما')
 await waitFor(()=>assert.equal(document.querySelectorAll('svg[data-code]').length,2))
 const print=screen.getByRole('button',{name:'طباعة الملصقات'})
 await waitFor(()=>assert.equal(print.disabled,false))
 fireEvent.click(print);assert.equal(state.prints,1)
 assert.equal(state.rpcCalls.length,0)
 assert.equal(!!document.querySelector('select'),false)
})
async function fillProduct() {
 fireEvent.click(screen.getByRole('button',{name:'إضافة منتج'}))
 const form=document.querySelector('form')
 fireEvent.change(form.querySelector('input[type="file"]'),{target:{files:[new window.File(['img'],'image.jpg',{type:'image/jpeg'})]}})
 fireEvent.change(screen.getByLabelText('كمية أبيض مقاس S'),{target:{value:'2'}})
 fireEvent.change(screen.getByLabelText('باركود الموديل العام · اختياري'),{target:{value:'MODELNEW'}})
 fireEvent.change(screen.getByLabelText('باركود أبيض S'),{target:{value:'0012345678'}})
 return form
}
test('product screen submits one atomic RPC with model and per-cell variant barcode',async()=>{
 reset();render(React.createElement(imports.Products));await screen.findByText('قميص الاختبار')
 const form=await fillProduct();fireEvent.submit(form)
 await waitFor(()=>assert.equal(state.rpcCalls.filter(c=>c.name==='engine_create_product_atomic').length,1))
 const call=state.rpcCalls.find(c=>c.name==='engine_create_product_atomic')
 assert.equal(call.args.p_tenant,'A');assert.equal(call.args.p_store,'branch')
 assert.equal(call.args.p_model_barcodes[0].barcode,'MODELNEW')
 assert.equal(call.args.p_variants[0].barcodes[0].barcode,'0012345678')
 assert.equal(call.args.p_variants[0].quantity,2)
 await waitFor(()=>assert.equal(!!document.querySelector('form'),false))
 assert.equal(state.rpcCalls.some(c=>c.name==='engine_generate_barcodes'),false)
})
test('product RPC failure retains inputs and re-enables save instead of partially inserting rows',async()=>{
 reset();state.rpcError={code:'23505',message:'duplicate'}
 render(React.createElement(imports.Products));await screen.findByText('قميص الاختبار')
 fireEvent.submit(await fillProduct())
 await screen.findByText('هذا الباركود مستخدم في المؤسسة؛ اختر رمزاً آخر.')
 assert.equal(screen.getByLabelText('باركود أبيض S').value,'0012345678')
 assert.equal(screen.getByRole('button',{name:'حفظ المنتج'}).disabled,false)
})
test('UUID fallback uses the existing variant after an authoritative empty registry lookup',async()=>{
 reset();render(React.createElement(imports.POS));await screen.findByText('قميص الاختبار')
 await scan('uuid-variant')
 await screen.findByText('تمت إضافة المقاس إلى السلة')
 assert.equal(!!screen.queryByRole('dialog'),false)
})
test('model picker cancellation does not add a cart line',async()=>{
 reset();render(React.createElement(imports.POS));await screen.findByText('قميص الاختبار')
 await scan('MODEL001');await screen.findByRole('dialog')
 fireEvent.click(screen.getByRole('button',{name:'إغلاق'}))
 assert.equal(!!screen.queryByRole('dialog'),false)
 assert.equal(!!screen.queryByText('تمت إضافة التركيبة المختارة'),false)
})
test('model/variant duplicate is rejected before upload/RPC',async()=>{
 reset();render(React.createElement(imports.Products));await screen.findByText('قميص الاختبار')
 const form=await fillProduct()
 fireEvent.change(screen.getByLabelText('باركود أبيض S'),{target:{value:'MODELNEW'}})
 fireEvent.submit(form)
 await screen.findByText('باركود مكرر بين الموديل والتركيبات')
 assert.equal(state.rpcCalls.some(c=>c.name==='engine_create_product_atomic'),false)
})
test('ambiguous network response locks re-submit and keeps the product draft',async()=>{
 reset();state.rpcError={message:'Failed to fetch'}
 render(React.createElement(imports.Products));await screen.findByText('قميص الاختبار')
 fireEvent.submit(await fillProduct())
 await screen.findByText(/تعذر تأكيد نتيجة الحفظ/)
 assert.equal(screen.getByRole('button',{name:'حفظ المنتج'}).disabled,true)
 assert.equal(screen.getByLabelText('باركود أبيض S').value,'0012345678')
})
test('printing absent model shows an empty state and blocks print; copies are integral',async()=>{
 reset();state.registry=state.registry.filter(row=>row.barcode_type==='variant')
 render(React.createElement(imports.Printing))
 await waitFor(()=>assert.ok(state.printed.includes('VARIANT01')))
 await choose('نوع الباركود للطباعة','باركود الموديل')
 await screen.findByText(/لا توجد رموز محفوظة من النوع المختار/)
 assert.equal(screen.getByRole('button',{name:'طباعة الملصقات'}).disabled,true)
 await choose('نوع الباركود للطباعة','باركود التركيبة')
 fireEvent.change(screen.getByRole('spinbutton'),{target:{value:'2.9'}})
 await waitFor(()=>assert.equal(document.querySelectorAll('svg[data-code]').length,2))
})
test('Phase3 actual product UI builds one composite ONE_SIZE cell and confirms destructive changes',async()=>{
 reset();render(React.createElement(imports.Products));await screen.findByText('قميص الاختبار')
 fireEvent.click(screen.getByRole('button',{name:'إضافة منتج'}))
 await choose('نوع اللون','لون مركب')
 await choose('مكونات اللون المركب','أسود');await choose('مكونات اللون المركب','أبيض')
 fireEvent.click(screen.getByRole('button',{name:'إضافة لون'}))
 await choose(/ملابس \(S/, 'مقاس موحد (مقاس موحد)')
 const input=screen.getByLabelText('كمية أبيض / أسود مقاس مقاس موحد')
 fireEvent.change(input,{target:{value:'3'}})
 window.confirm=()=>false
 await choose('مقاس موحد (مقاس موحد)', /أحذية/)
 assert.equal(screen.getByLabelText('كمية أبيض / أسود مقاس مقاس موحد').value,'3')
 window.confirm=()=>true
 await choose('مقاس موحد (مقاس موحد)', /أحذية/)
 assert.equal(!!screen.queryByLabelText('كمية أبيض / أسود مقاس مقاس موحد'),false)
})
test('Phase3 model picker retains explicit color and ONE_SIZE confirmation',async()=>{
 reset();state.products[0].product_variants[0]={...state.products[0].product_variants[0],color:'أبيض / أسود',color_components:['أبيض','أسود'],size:'ONE_SIZE'}
 render(React.createElement(imports.POS));await screen.findByText('قميص الاختبار');await scan('MODEL001')
 const confirm=await screen.findByRole('button',{name:'تأكيد التركيبة وإضافتها للسلة'});assert.equal(confirm.disabled,true)
 await choose('لون الموديل','أبيض / أسود');assert.equal(confirm.disabled,true)
 await choose('مقاس الموديل','مقاس موحد · المتاح 3');assert.equal(confirm.disabled,false)
})
test('Phase3 product submits structured composite ONE_SIZE through existing atomic RPC',async()=>{
 reset();render(React.createElement(imports.Products));await screen.findByText('قميص الاختبار')
 fireEvent.click(screen.getByRole('button',{name:'إضافة منتج'}))
 await choose(/ملابس \(S/, 'مقاس موحد (مقاس موحد)')
 await choose('نوع اللون','لون مركب')
 await choose('مكونات اللون المركب','أسود');await choose('مكونات اللون المركب','أبيض')
 fireEvent.click(screen.getByRole('button',{name:'إضافة لون'}))
 fireEvent.change(screen.getByLabelText('كمية أبيض / أسود مقاس مقاس موحد'),{target:{value:'3'}})
 const form=document.querySelector('form')
 fireEvent.change(form.querySelector('input[type="file"]'),{target:{files:[new window.File(['img'],'bag.jpg',{type:'image/jpeg'})]}})
 fireEvent.submit(form)
 await waitFor(()=>assert.equal(state.rpcCalls.filter(c=>c.name==='engine_create_product_atomic').length,1))
 const variants=state.rpcCalls.find(c=>c.name==='engine_create_product_atomic').args.p_variants
 assert.equal(variants.length,1);assert.equal(variants[0].size,'ONE_SIZE');assert.equal(variants[0].quantity,3)
 assert.deepEqual(variants[0].color_components,['أبيض','أسود'])
 assert.equal(!!document.querySelector('select'),false)
})
