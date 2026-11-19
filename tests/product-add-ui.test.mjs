// Isolated UI test for the add-product screen: app/dashboard/_screens/products.js
// The REAL component is bundled with esbuild. Every backend boundary module is
// replaced by the shared fixture mocks (plus a push spy), so a save attempt can
// never reach Supabase, Storage, the network or the push service.
import test, { afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { JSDOM } from 'jsdom'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { hybridUIModules } from './fixtures/hybrid-ui-modules.mjs'

// The esbuild fixture doesn't load Tailwind. Honour the disclosure's hidden
// class so role queries distinguish a reachable control from a mounted draft.
const dom = new JSDOM('<!doctype html><style>.hidden { display: none }</style><body></body>', { url: 'https://local.test/dashboard/stock?tab=products' })
for (const key of ['window','document','HTMLElement','HTMLInputElement','Node','Event','MouseEvent','KeyboardEvent','MutationObserver','localStorage']) globalThis[key] = dom.window[key]
Object.defineProperty(globalThis,'navigator',{value:dom.window.navigator, configurable:true})
globalThis.IS_REACT_ACT_ENVIRONMENT = true
globalThis.requestAnimationFrame = callback => setTimeout(callback,0)
globalThis.cancelAnimationFrame = clearTimeout
URL.createObjectURL = () => 'blob:test-image'
HTMLElement.prototype.scrollIntoView = () => {}
const React = await import('react')
const { render, fireEvent, screen, within, isInaccessible, waitFor, cleanup } = await import('@testing-library/react')

const root = process.cwd()
const context = {tenantId:'A',storeId:'branch',staffId:'staff',storeType:'mens',role:'owner',user:{id:'auth'},stores:[{id:'branch'}],storeIds:['branch']}
const variant = {id:'uuid-variant',color:'أسود',size:'M',barcode:'VARIANT01',min_price:0,inventory:[{store_id:'branch',quantity:10,reserved_qty:7}]}
const records = [
 {id:'m',tenant_id:'A',product_id:'p',variant_id:null,barcode:'MODEL001',barcode_type:'model'},
 {id:'v',tenant_id:'A',product_id:'p',variant_id:variant.id,barcode:'VARIANT01',barcode_type:'variant'},
]
const product = {id:'p',tenant_id:'A',name:'قميص الاختبار',is_active:true,base_price:100,product_variants:[variant],product_barcodes:records}
const nativeFetch = globalThis.fetch
let state

function reset() {
  state = {context:{...context},products:[structuredClone(product)],rpcCalls:[],storageUploads:[],notifications:[],fetchCalls:[],rpcError:null,uploadError:null}
  // Any real network attempt is recorded and fails loudly.
  globalThis.fetch = (...args) => { state.fetchCalls.push(String(args[0])); return Promise.reject(new Error('real network blocked in test')) }
  function query(table) {
    const q={ table,filters:{},select(){return this},eq(k,v){this.filters[k]=v;return this},order(){return this},range(){return this},limit(){return this},in(){return this},
      result(single=false){
        const data=state.products.filter(row=>Object.entries(this.filters).every(([k,v])=>k.includes('.')||row[k]===v))
        return {data:single?(data[0]||null):data,error:null}
      },single(){return Promise.resolve(this.result(true))},maybeSingle(){return Promise.resolve(this.result(true))},then(resolve,reject){return Promise.resolve(this.result()).then(resolve,reject)}}
    return q
  }
  state.supabase={from:query,
    async rpc(name,args){
      state.rpcCalls.push({name,args})
      return name==='engine_create_product_atomic'
        ? {data:state.rpcError?null:'created-product',error:state.rpcError}
        : {data:[],error:null}
    },
    storage:{from(bucket){return {
      async upload(uploadPath,file,opts){ state.storageUploads.push({bucket,path:uploadPath,file,opts}); return {error:state.uploadError} },
      getPublicUrl(p){ return {data:{publicUrl:`https://example.test/${p}`}} },
    }}}}
  globalThis.__hybridUI=state
}
afterEach(() => { cleanup(); globalThis.fetch = nativeFetch })

const mocks = {
  ...hybridUIModules,
  // Capture the push call so the test can prove notifications never really fire.
  '@/lib/push/client':`export const notifyBranchPush=(...args)=>{globalThis.__hybridUI.notifications.push(args); return Promise.resolve()}`,
}
const outfile=path.join(root,'.cache','product-add-ui','Products.mjs')
await build({entryPoints:[path.join(root,'app/dashboard/_screens/products.js')],outfile,bundle:true,platform:'node',format:'esm',jsx:'automatic',loader:{'.js':'jsx'},external:['react','react-dom','react-dom/client','react/jsx-runtime'],plugins:[{name:'test-backend',setup(b){
  b.onResolve({filter:/.*/},args=>Object.hasOwn(mocks,args.path)?{path:args.path,namespace:'mock'}:args.path.startsWith('@/')?{path:path.join(root,args.path.slice(2)+'.js')}:undefined)
  b.onLoad({filter:/.*/,namespace:'mock'},args=>({contents:mocks[args.path],loader:'jsx',resolveDir:root}))
}}]})
const Products=(await import(pathToFileURL(outfile))).default

const body = id => document.querySelector(`#product-section-${id}`)
const toggle = id => document.querySelector(`button[aria-controls="product-section-${id}"]`)
const isOpen = id => toggle(id).getAttribute('aria-expanded') === 'true'
const isHidden = id => isInaccessible(body(id))
const toggleSection = id => fireEvent.click(toggle(id))
function openBarcodeFields() {
  toggleSection('advanced')
  toggleSection('barcode')
}
const photoGroup = form => within(form).getByRole('group',{name:/صورة المنتج/})
const imageFile = () => new window.File(['img'],'product.jpg',{type:'image/jpeg'})
const setImage = form => fireEvent.change(within(photoGroup(form)).getByLabelText('اختيار صورة من الجهاز'), {target:{files:[imageFile()]}})
const setQty = (color,size,value) => fireEvent.change(screen.getByLabelText(`كمية ${color} مقاس ${size}`), {target:{value}})

async function openForm() {
  render(React.createElement(Products))
  await screen.findByText('قميص الاختبار')
  fireEvent.click(screen.getByRole('button',{name:'إضافة منتج'}))
  return document.querySelector('form')
}

test('A. photo comes first, then type, optional name and price, inline variants, Advanced and Save', async(t)=>{
  reset()
  const form=await openForm()
  const photo=photoGroup(form)
  assert.ok(photo.contains(form.querySelector('input')), 'the first field belongs to the photo picker')
  assert.ok(!photo.closest('[data-product-section]'), 'photo is outside the disclosures')
  const capture=photo.querySelector('input[type="file"][accept="image/*"][capture="environment"]')
  assert.ok(capture, 'rear-camera file input is present')
  const requestCapture=t.mock.method(capture,'click')
  fireEvent.click(within(photo).getByRole('button',{name:'التقاط صورة'}))
  assert.equal(requestCapture.mock.callCount(),1)
  fireEvent.change(capture,{target:{files:[imageFile()]}})
  assert.ok(within(photo).getByRole('img',{name:'معاينة صورة المنتج'}))
  assert.equal(within(photo).getByLabelText('اختيار صورة من الجهاز').type,'file')
  assert.deepEqual(
    [...form.querySelectorAll('[data-product-section]')].map(section=>section.dataset.productSection),
    ['basics','variants','advanced','barcode'],
  )
  assert.ok(body('advanced').contains(toggle('barcode')), 'barcode is nested under Advanced')
  const basics=within(body('basics'))
  const type=basics.getByRole('button',{name:'نوع المنتج'})
  const name=basics.getByRole('textbox',{name:'اسم المنتج'})
  const price=basics.getByRole('spinbutton',{name:/سعر البيع/})
  assert.equal(name.required,false)
  assert.equal(price.required,false)
  const save=within(form).getByRole('button',{name:'حفظ المنتج'})
  const order=[photo,type,name,price,within(body('variants')).getByRole('table'),toggle('advanced'),save]
  for (let i=1;i<order.length;i++) {
    assert.ok(order[i-1].compareDocumentPosition(order[i]) & Node.DOCUMENT_POSITION_FOLLOWING, 'fields follow the merchant entry order')
  }
  assert.equal(save.type,'submit')
  assert.ok(form.lastElementChild===save, 'save is outside the disclosures and last in the form')
})

test('B. basics and variants start open; secondary fields and manual barcodes are under folded Advanced', async()=>{
  reset()
  await openForm()
  for (const id of ['basics','variants']) {
    assert.equal(isOpen(id),true)
    assert.equal(isHidden(id),false)
  }
  for (const id of ['advanced','barcode']) {
    assert.equal(isOpen(id),false,`${id} folded`)
    assert.equal(isHidden(id),true,`${id} body hidden`)
  }
  fireEvent.click(screen.getByRole('button',{name:/^التفاصيل المتقدمة/}))
  const advanced=within(body('advanced'))
  for (const [role,name] of [
    ['button','التصنيف حسب نوع المتجر'], ['button','الماركة / اسم المنتج'], ['textbox','وصف المنتج'],
    ['button','نوع القماش'], ['button','الستايل'], ['button','توليد وصف عربي تلقائياً'],
    ['spinbutton','سعر التكلفة'], ['button',/^الباركود/], ['textbox',/^رابط فيديو المنتج/],
  ]) advanced.getByRole(role,{name})
  assert.equal(isHidden('barcode'),true, 'manual codes still have their own disclosure')
})

test('C. folding and reopening keeps text, matrix, variant barcode and image preview', async()=>{
  reset()
  const form=await openForm()
  fireEvent.change(screen.getByLabelText('اسم المنتج'),{target:{value:'قميص صيفي'}})
  setQty('أبيض','S','7')
  openBarcodeFields()
  fireEvent.change(screen.getByLabelText('وصف المنتج'),{target:{value:'وصف المسودة'}})
  fireEvent.change(screen.getByLabelText('باركود أبيض S'),{target:{value:'0012345678'}})
  setImage(form)

  for (const id of ['barcode','advanced','variants','basics']) {
    toggleSection(id)
    assert.equal(isOpen(id),false)
  }
  const preview=() => within(photoGroup(form)).getByRole('img',{name:'معاينة صورة المنتج'})
  assert.equal(preview().getAttribute('src'),'blob:test-image', 'preview is visible even with all sections folded')

  for (const id of ['basics','variants','advanced','barcode']) {
    toggleSection(id)
    assert.equal(isHidden(id),false)
  }
  assert.equal(screen.getByLabelText('اسم المنتج').value,'قميص صيفي')
  assert.equal(screen.getByLabelText('كمية أبيض مقاس S').value,'7')
  assert.equal(screen.getByLabelText('وصف المنتج').value,'وصف المسودة')
  assert.equal(screen.getByLabelText('باركود أبيض S').value,'0012345678')
  assert.equal(preview().getAttribute('src'),'blob:test-image')
})

test('D1. missing photo blocks save with its picker accessible and Advanced still folded', async()=>{
  reset()
  const form=await openForm()
  setQty('أبيض','S','2')
  fireEvent.click(screen.getByRole('button',{name:'حفظ المنتج'}))
  await screen.findByText(/صورة المنتج إلزامية/)
  assert.equal(isInaccessible(within(photoGroup(form)).getByLabelText('اختيار صورة من الجهاز')),false)
  assert.equal(isOpen('advanced'),false)
  assert.equal(state.storageUploads.length,0)
  assert.equal(state.rpcCalls.length,0)
})

test('D2. an invalid quantity opens the variants section', async()=>{
  reset()
  const form=await openForm()
  setImage(form)
  setQty('أبيض','S','1.5')
  fireEvent.submit(form)
  await screen.findByText(/أعداداً صحيحة غير سالبة/)
  assert.equal(isOpen('variants'),true)
  assert.equal(isHidden('variants'),false)
})

test('D3. a duplicate barcode opens the barcode section without calling the RPC', async()=>{
  reset()
  const form=await openForm()
  setImage(form)
  setQty('أبيض','S','2')
  openBarcodeFields()
  fireEvent.change(screen.getByLabelText('باركود الموديل العام · اختياري'),{target:{value:'DUP'}})
  fireEvent.change(screen.getByLabelText('باركود أبيض S'),{target:{value:'DUP'}})
  toggleSection('barcode')
  toggleSection('advanced')
  fireEvent.submit(form)
  await screen.findByText('باركود مكرر بين الموديل والتركيبات')
  assert.equal(isOpen('advanced'),true)
  assert.equal(isOpen('barcode'),true)
  assert.equal(isHidden('barcode'),false)
  assert.equal(state.rpcCalls.length,0)
})

test('D4. an invalid video link reopens Advanced and keeps the link reachable for correction', async()=>{
  reset()
  const form=await openForm()
  setImage(form)
  setQty('أبيض','S','2')
  toggleSection('advanced')
  const video=() => within(body('advanced')).getByRole('textbox',{name:/^رابط فيديو المنتج/})
  // A syntactically valid URL reaches the product validator, not just the browser's URL check.
  const invalid='ftp://example.test/clip'
  fireEvent.change(video(),{target:{value:invalid}})
  toggleSection('advanced')
  assert.equal(isHidden('advanced'),true)
  fireEvent.click(screen.getByRole('button',{name:'حفظ المنتج'}))
  await screen.findByText('رابط الفيديو غير صالح')
  assert.equal(isOpen('advanced'),true)
  assert.equal(video().value,invalid)
  assert.equal(state.storageUploads.length,0)
  assert.equal(state.rpcCalls.length,0)
})

test('E. a save attempt stays inside the mocks: no real RPC, Storage upload, push or network', async()=>{
  reset()
  const form=await openForm()
  setImage(form)
  setQty('أبيض','S','2')
  fireEvent.change(screen.getByRole('spinbutton',{name:/سعر البيع/}),{target:{value:'0'}})
  openBarcodeFields()
  fireEvent.change(screen.getByLabelText('باركود الموديل العام · اختياري'),{target:{value:'MODELNEW'}})
  fireEvent.change(screen.getByLabelText('باركود أبيض S'),{target:{value:'0012345678'}})
  fireEvent.click(screen.getByRole('button',{name:'حفظ المنتج'}))
  await waitFor(()=>assert.equal(state.rpcCalls.filter(call=>call.name==='engine_create_product_atomic').length,1))
  const call=state.rpcCalls.find(call=>call.name==='engine_create_product_atomic')
  assert.equal(call.args.p_tenant,'A')
  assert.equal(call.args.p_store,'branch')
  assert.equal(call.args.p_product.base_price,0)
  assert.equal(call.args.p_model_barcodes[0].barcode,'MODELNEW')
  assert.equal(call.args.p_variants[0].barcodes[0].barcode,'0012345678')
  assert.equal(state.storageUploads.length,1)
  assert.equal(state.storageUploads[0].bucket,'products')
  assert.equal(state.notifications.length,1,'push notification captured by the mock only')
  assert.equal(state.fetchCalls.length,0,'no real network call happened')
  await waitFor(()=>assert.ok(!document.querySelector('form')))
})
