// In-memory local review ONLY. No Supabase client/keys, persistence or network.
// Database constraints are tested separately in phase2 SQL acceptance suites.
export function installHybridPreviewBackend() {
  const context = {tenantId:'demo',storeId:'branch',staffId:'staff',storeType:'mens',role:'owner',user:{id:'demo-auth'},stores:[{id:'branch'}],storeIds:['branch']}
  let counter = 100000000100
  const variant = {id:'11111111-1111-4111-8111-111111111111',color:'أسود',size:'M',barcode:'100000000001',min_price:0,inventory:[{store_id:'branch',quantity:10,reserved_qty:7}]}
  const registry = [
    {id:'m',tenant_id:'demo',product_id:'p',variant_id:null,barcode:'100000000000',barcode_type:'model'},
    {id:'v',tenant_id:'demo',product_id:'p',variant_id:variant.id,barcode:'100000000001',barcode_type:'variant'},
  ]
  const state = {context,products:[{id:'p',tenant_id:'demo',name:'قميص تجريبي · كمية 10 / محجوز 7',base_price:2500,is_active:true,product_variants:[variant],product_barcodes:registry.slice()}],registry}
  // Phase 3 examples are ephemeral and use distinct real-looking demo codes.
  for (const [index, name, color, parts, sizes] of [
    [2,'حقيبة · مقاس موحد','أسود',['أسود'],['ONE_SIZE']],
    [3,'حقيبة · لون مركب','أبيض / أسود',['أبيض','أسود'],['ONE_SIZE']],
    [4,'قميص مخطط · لون مركب','أبيض / أزرق',['أبيض','أزرق'],['M','L']],
  ]) {
    const pid='phase3-'+index;
    const variants=sizes.map((size,j)=>({id:pid+'-'+j,color,color_components:parts,size,barcode:String(200000000000+index*100+j+1),inventory:[{store_id:'branch',quantity:10,reserved_qty:7}]}));
    const rows=[{id:pid+'-model',tenant_id:'demo',product_id:pid,variant_id:null,barcode:String(200000000000+index*100),barcode_type:'model'},...variants.map(v=>({id:v.id+'-code',tenant_id:'demo',product_id:pid,variant_id:v.id,barcode:v.barcode,barcode_type:'variant'}))];
    registry.push(...rows);state.products.push({id:pid,tenant_id:'demo',name,base_price:2500,is_active:true,product_variants:variants,product_barcodes:rows});
  }
  const response=(data=null,error=null)=>({data,error})
  function query(table) {
    return {filters:{},select(){return this},eq(k,v){this.filters[k]=v;return this},order(){return this},range(){return this},limit(){return this},
      result(single=false){
        let rows=table==='products'?state.products:table==='product_variants'?state.products.flatMap(p=>p.product_variants.map(v=>({...v,product_id:p.id}))):table==='product_barcodes'?state.registry:table==='stores'?[{id:'branch',name:'معاينة محلية معزولة'}]:[]
        rows=rows.filter(row=>Object.entries(this.filters).every(([k,v])=>k.includes('.')||row[k]===v))
        return response(single?rows[0]||null:rows)
      },single(){return Promise.resolve(this.result(true))},maybeSingle(){return Promise.resolve(this.result(true))},then(resolve,reject){return Promise.resolve(this.result()).then(resolve,reject)},
    }
  }
  state.supabase={from:query,async rpc(name,args){
    if(name==='engine_generate_barcodes') return response(Array.from({length:args.p_count},()=>String(++counter)))
    if(name!=='engine_create_product_atomic') return response([])
    const pid=crypto.randomUUID();const incoming=[];const variants=[]
    for(const item of args.p_variants) {
      const vid=crypto.randomUUID();const codes=item.barcodes.length?item.barcodes:[{barcode:String(++counter)}]
      variants.push({...item,id:vid,barcode:codes[0].barcode,inventory:[{store_id:'branch',quantity:item.quantity,reserved_qty:0}]})
      codes.forEach(b=>incoming.push({id:crypto.randomUUID(),tenant_id:'demo',product_id:pid,variant_id:vid,barcode:b.barcode,barcode_type:'variant'}))
    }
    args.p_model_barcodes.forEach(b=>incoming.push({id:crypto.randomUUID(),tenant_id:'demo',product_id:pid,variant_id:null,barcode:b.barcode,barcode_type:'model'}))
    const codes=incoming.map(b=>b.barcode)
    if(new Set(codes).size!==codes.length || codes.some(code=>state.registry.some(row=>row.barcode===code))) return response(null,{code:'23505',message:'duplicate'})
    state.registry.push(...incoming)
    state.products.unshift({...args.p_product,id:pid,tenant_id:'demo',is_active:true,product_variants:variants,product_barcodes:incoming})
    window.dispatchEvent(new Event('hybrid-preview-created'))
    return response(pid)
  },storage:{from(){let image='';return {async upload(path,file){image=URL.createObjectURL(file);return response(path)},getPublicUrl(){return {data:{publicUrl:image}}}}}}}
  globalThis.__hybridUI=state
  return state
}
