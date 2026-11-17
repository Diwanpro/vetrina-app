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

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://local.test/dashboard/stock?tab=products' })
for (const key of ['window','document','HTMLElement','HTMLInputElement','Node','Event','MouseEvent','KeyboardEvent','MutationObserver','localStorage']) globalThis[key] = dom.window[key]
Object.defineProperty(globalThis,'navigator',{value:dom.window.navigator, configurable:true})
globalThis.IS_REACT_ACT_ENVIRONMENT = true
globalThis.requestAnimationFrame = callback => setTimeout(callback,0)
globalThis.cancelAnimationFrame = clearTimeout
URL.createObjectURL = () => 'blob:test-image'
HTMLElement.prototype.scrollIntoView = () => {}
const React = await import('react')
const { render, fireEvent, screen, waitFor, cleanup } = await import('@testing-library/react')

const root = process.cwd()
const context = {tenantId:'A',storeId:'branch',staffId:'staff',storeType:'mens',role:'owner',user:{id:'auth'},stores:[{id:'branch'}],storeIds:['branch']}
const variant = {id:'uuid-variant',color:'أسود',size:'M',barcode:'VARIANT01',min_price:0,inventory:[{store_id:'branch',quantity:10,reserved_qty:7}]}
const records = [
 {id:'m',tenant_id:'A',product_id:'p',variant_id:null,barcode:'MODEL001',barcode_type:'model'},
 {id:'v',tenant_id:'A',product_id:'p',variant_id:variant.id,barcode:'VARIANT01',barcode_type:'variant'},
]
const product = {id:'p',tenant_id:'A',name:'قميص الاختبار',is_active:true,base_price:100,product_variants:[variant],product_barcodes:records}
const SECTION_IDS = ['basics','variants','pricing','barcode','media']
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
const isHidden = id => body(id).className.trim() === 'hidden'
const imageFile = () => new window.File(['img'],'product.jpg',{type:'image/jpeg'})
const setImage = form => fireEvent.change(form.querySelector('input[type="file"]'), {target:{files:[imageFile()]}})
const setQty = (color,size,value) => fireEvent.change(screen.getByLabelText(`كمية ${color} مقاس ${size}`), {target:{value}})

async function openForm() {
  render(React.createElement(Products))
  await screen.findByText('قميص الاختبار')
  fireEvent.click(screen.getByRole('button',{name:'إضافة منتج'}))
  return document.querySelector('form')
}

test('A. the five sections exist once each, in order, with the save button last', async()=>{
  reset()
  const form=await openForm()
  const container=form.querySelector('div.space-y-3')
  assert.ok(container,'sections container exists')
  const sections=[...container.children].filter(element=>element.tagName==='SECTION')
  assert.equal(sections.length,5)
  assert.deepEqual(
    sections.map(section=>section.querySelector('div[id^="product-section-"]').id),
    SECTION_IDS.map(id=>`product-section-${id}`),
  )
  for (const id of SECTION_IDS) {
    assert.equal(document.querySelectorAll(`#product-section-${id}`).length,1,`${id} appears once`)
    assert.ok(toggle(id),`toggle button for ${id}`)
  }
  const save=form.querySelector('button[type="submit"]')
  assert.ok(save,'submit button exists')
  assert.match(save.textContent,/حفظ المنتج/)
  assert.equal(container.contains(save),false,'save button is outside the sections container')
  assert.equal(container.compareDocumentPosition(save),Node.DOCUMENT_POSITION_FOLLOWING,'save button follows the sections')
  assert.equal(form.lastElementChild,save,'save button is the last element of the form')
})

test('B. initial state: basics and variants open, pricing/barcode/media folded', async()=>{
  reset()
  await openForm()
  assert.equal(isOpen('basics'),true)
  assert.equal(isOpen('variants'),true)
  assert.equal(isHidden('basics'),false)
  assert.equal(isHidden('variants'),false)
  for (const id of ['pricing','barcode','media']) {
    assert.equal(isOpen(id),false,`${id} folded`)
    assert.equal(isHidden(id),true,`${id} body hidden`)
  }
})

test('C. folding and reopening keeps text, matrix, variant barcode and image preview', async()=>{
  reset()
  const form=await openForm()
  fireEvent.change(screen.getByLabelText('اسم المنتج'),{target:{value:'قميص صيفي'}})
  setQty('أبيض','S','7')
  fireEvent.change(screen.getByLabelText('باركود أبيض S'),{target:{value:'0012345678'}})
  setImage(form)

  fireEvent.click(toggle('basics'))
  assert.equal(isOpen('basics'),false)
  fireEvent.click(toggle('basics'))
  assert.equal(isOpen('basics'),true)
  assert.equal(screen.getByLabelText('اسم المنتج').value,'قميص صيفي')

  fireEvent.click(toggle('variants'))
  assert.equal(isOpen('variants'),false)
  fireEvent.click(toggle('variants'))
  assert.equal(isOpen('variants'),true)
  assert.equal(screen.getByLabelText('كمية أبيض مقاس S').value,'7')
  assert.equal(screen.getByLabelText('باركود أبيض S').value,'0012345678')

  // media starts folded, so: open, fold, reopen — the preview must survive.
  fireEvent.click(toggle('media'))
  assert.equal(isOpen('media'),true)
  fireEvent.click(toggle('media'))
  assert.equal(isOpen('media'),false)
  fireEvent.click(toggle('media'))
  assert.equal(isOpen('media'),true)
  assert.ok(document.querySelector('#product-section-media img'),'image preview is still mounted')
})

test('D1. a missing required image opens the media section', async()=>{
  reset()
  const form=await openForm()
  setQty('أبيض','S','2')
  fireEvent.submit(form)
  await screen.findByText(/صورة المنتج إلزامية/)
  assert.equal(isOpen('media'),true)
  assert.equal(isHidden('media'),false)
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
  fireEvent.change(screen.getByLabelText('باركود الموديل العام · اختياري'),{target:{value:'DUP'}})
  fireEvent.change(screen.getByLabelText('باركود أبيض S'),{target:{value:'DUP'}})
  fireEvent.submit(form)
  await screen.findByText('باركود مكرر بين الموديل والتركيبات')
  assert.equal(isOpen('barcode'),true)
  assert.equal(isHidden('barcode'),false)
  assert.equal(state.rpcCalls.length,0)
})

test('D4. an invalid video link opens the media section', async()=>{
  reset()
  const form=await openForm()
  setImage(form)
  setQty('أبيض','S','2')
  // The video field's <label> also holds a help line, so query it by placeholder.
  fireEvent.change(screen.getByPlaceholderText('https://www.tiktok.com/@shop/video/...'),{target:{value:'ليس رابطاً'}})
  fireEvent.submit(form)
  await screen.findByText('رابط الفيديو غير صالح')
  assert.equal(isOpen('media'),true)
})

test('E. a save attempt stays inside the mocks: no real RPC, Storage upload, push or network', async()=>{
  reset()
  const form=await openForm()
  setImage(form)
  setQty('أبيض','S','2')
  fireEvent.change(screen.getByLabelText('باركود الموديل العام · اختياري'),{target:{value:'MODELNEW'}})
  fireEvent.change(screen.getByLabelText('باركود أبيض S'),{target:{value:'0012345678'}})
  fireEvent.submit(form)
  await waitFor(()=>assert.equal(state.rpcCalls.filter(call=>call.name==='engine_create_product_atomic').length,1))
  const call=state.rpcCalls.find(call=>call.name==='engine_create_product_atomic')
  assert.equal(call.args.p_tenant,'A')
  assert.equal(call.args.p_store,'branch')
  assert.equal(call.args.p_model_barcodes[0].barcode,'MODELNEW')
  assert.equal(call.args.p_variants[0].barcodes[0].barcode,'0012345678')
  assert.equal(state.storageUploads.length,1)
  assert.equal(state.storageUploads[0].bucket,'products')
  assert.equal(state.notifications.length,1,'push notification captured by the mock only')
  assert.equal(state.fetchCalls.length,0,'no real network call happened')
  await waitFor(()=>assert.equal(document.querySelector('form'),null))
})
