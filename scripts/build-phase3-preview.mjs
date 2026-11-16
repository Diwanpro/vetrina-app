// This branch's Vercel deployment is deliberately preview-only. Never run a
// database migration, load Next/Supabase environment, or generate API routes.
import { execFileSync } from 'node:child_process'
import fs from 'node:fs/promises'
if (process.env.VERCEL_ENV !== 'preview') {
  throw new Error('Phase 3 mock review build refuses non-preview deployments. Remove preview-only Vercel config only after production approval.')
}
await fs.rm('.cache/hybrid-preview', {recursive:true,force:true})
execFileSync(process.execPath,['scripts/preview-hybrid.mjs','--build-only'],{stdio:'inherit'})
const names=await fs.readdir('.cache/hybrid-preview')
if (names.sort().join(',') !== 'app.js,index.html,styles.css') throw new Error('Unexpected static preview outputs')
const bundle=await fs.readFile('.cache/hybrid-preview/app.js','utf8')
if (/scfwdjbgwlaptbnjkofk|supabase\.co|SUPABASE_SERVICE_ROLE_KEY/.test(bundle)) throw new Error('Unexpected Supabase reference in isolated preview bundle')
console.log('Static mock preview verified: three assets, no API/functions or Live database client.')

// Build Output API bypasses generic auto-detection (including root middleware).
const output = '.vercel/output'
await fs.rm(output, {recursive:true,force:true})
await fs.mkdir(output, {recursive:true})
await fs.cp('.cache/hybrid-preview', output + '/static', {recursive:true})
const settings = JSON.parse(await fs.readFile('vercel.json','utf8'))
const headers = Object.fromEntries(settings.headers[0].headers.map(h => [h.key,h.value]))
await fs.writeFile(output + '/config.json', JSON.stringify({version:3,routes:[{src:'/(.*)',headers,continue:true},{handle:'filesystem'}]}))
console.log('Explicit static Build Output API generated; no middleware or functions.')
