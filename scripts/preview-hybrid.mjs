// Explicit isolated review harness: bundles actual UI screens against in-memory
// fixtures. No live database credentials, no production routing/config changes.
import { build } from 'esbuild'
import { execFileSync } from 'node:child_process'
import { createServer } from 'node:http'
import fs from 'node:fs/promises'
import path from 'node:path'
import { hybridUIModules } from '../tests/fixtures/hybrid-ui-modules.mjs'
const buildOnly = process.argv.includes('--build-only')
const root=process.cwd(),dir=path.join(root,'.cache/hybrid-preview')
await fs.mkdir(dir,{recursive:true})
const mocks={...hybridUIModules};delete mocks.jsbarcode
const entry=`
import React,{useState,useEffect} from 'react';import {createRoot} from 'react-dom/client';
import {installHybridPreviewBackend} from './tests/fixtures/hybrid-preview-backend.js';
import POS from './app/dashboard/pos/page.js';import Products from './app/dashboard/_screens/products.js';import Printing from './app/dashboard/products/barcodes/page.js';
installHybridPreviewBackend();
function Demo(){const [tab,setTab]=useState('pos');const [version,setVersion]=useState(0);const [pid,setPid]=useState('p');
useEffect(()=>{const navigate=e=>{const a=e.target.closest?.('a[href]');if(a?.getAttribute('href')?.includes('/products/barcodes')){e.preventDefault();const id=new URL(a.href).searchParams.get('product')||'p';setPid(id);history.replaceState(null,'','/?product='+id);setTab('printing')}};document.addEventListener('click',navigate);return()=>document.removeEventListener('click',navigate)},[]);
useEffect(()=>{const fn=()=>setVersion(v=>v+1);window.addEventListener('hybrid-preview-created',fn);return()=>window.removeEventListener('hybrid-preview-created',fn)},[]);
const go=t=>{history.replaceState(null,'','/?product='+encodeURIComponent(pid));setTab(t)};
return <><header className="sticky top-0 z-[80] border-b border-amber-500/30 bg-[#171717] p-3 text-sm text-neutral-100 print:hidden"><strong className="text-amber-300">معاينة Phase 3 ببيانات وهمية — لا اتصال بقاعدة Live ولا حفظ دائم</strong><p className="mt-1 text-xs text-neutral-400">هذه الشاشات الفعلية مع بديل محلي للاتصال والصوت والتنبيهات والإيصالات. إعادة تشغيل الصفحة تمسح التجربة.</p><nav className="my-3 flex flex-wrap gap-2">{[['pos','الكاشير'],['products','إضافة المنتج'],['printing','الملصقات']].map(([value,label])=><button className="rounded border border-gold/40 px-3 py-2" key={value} onClick={()=>go(value)}>{label}</button>)}</nav><p className="text-xs">للمسح: اضغط «مسح الباركود» في الكاشير وأدخل رمز الموديل <b>100000000000</b> أو التركيبة <b>100000000001</b>. المتاح 3 فقط. لا تؤكد بيعاً نهائياً في هذه المعاينة.</p>{tab==='printing'&&<div className="mt-2 flex flex-wrap gap-2">{globalThis.__hybridUI.products.map(p=><button className="rounded border border-white/20 p-2 text-xs" key={p.id} onClick={()=>{setPid(p.id);history.replaceState(null,'','/?product='+p.id)}}>{p.name}</button>)}</div>}</header><div className="mx-auto max-w-5xl p-4">{tab==='pos'?<POS key={'pos'+version}/>:tab==='products'?<Products/>:<Printing key={pid}/>}</div></>}
createRoot(document.getElementById('root')).render(<Demo/>);
`
await build({stdin:{contents:entry,resolveDir:root,loader:'jsx'},outfile:path.join(dir,'app.js'),bundle:true,platform:'browser',format:'esm',jsx:'automatic',loader:{'.js':'jsx'},plugins:[{name:'isolated-demo',setup(b){
 b.onResolve({filter:/.*/},args=>Object.hasOwn(mocks,args.path)?{path:args.path,namespace:'mock'}:args.path.startsWith('@/')?{path:path.join(root,args.path.slice(2)+'.js')}:undefined)
 b.onLoad({filter:/.*/,namespace:'mock'},args=>({contents:mocks[args.path],loader:'jsx',resolveDir:root}))
}}]})
execFileSync(process.execPath,[path.join(root,'node_modules/tailwindcss/lib/cli.js'),'-i','app/globals.css','-o',path.join(dir,'styles.css')],{cwd:root,stdio:'inherit'})
const html='<!doctype html><html lang="ar" dir="rtl"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>معاينة Phase 3 — بيانات وهمية</title><link rel="stylesheet" href="/styles.css"><body style="background:#141414;color:white;font-family:Tahoma,sans-serif"><div id="root"></div><script type="module" src="/app.js"></script></body></html>'
await fs.writeFile(path.join(dir,'index.html'),html)
if (!buildOnly) createServer(async(req,res)=>{
 const url=new URL(req.url,'http://preview');const file=url.pathname==='/app.js'?'app.js':url.pathname==='/styles.css'?'styles.css':null
 res.setHeader('Cache-Control','no-store')
 res.setHeader('Content-Type',file==='app.js'?'text/javascript; charset=utf-8':file==='styles.css'?'text/css; charset=utf-8':'text/html; charset=utf-8')
 res.end(file?await fs.readFile(path.join(dir,file)):html)
}).listen(3000,'0.0.0.0',()=>console.log('Isolated hybrid barcode preview ready on 0.0.0.0:3000'))
