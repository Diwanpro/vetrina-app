import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { branchStoreHref } from '../lib/branch-store.js'
const read = file => fs.readFile(new URL(`../${file}`, import.meta.url), 'utf8')
test('store URL is from the selected authorized branch, never first branch fallback', () => {
 const stores=[{id:'a',slug:'branch-a'},{id:'b',slug:'فرع ب'}]
 assert.equal(branchStoreHref(stores,'a'),'/s/branch-a')
 assert.equal(branchStoreHref(stores,'b'),`/s/${encodeURIComponent('فرع ب')}`)
 assert.equal(branchStoreHref(stores,'all'),'')
 assert.equal(branchStoreHref(stores,'foreign'),'')
 assert.equal(branchStoreHref([{id:'a',slug:''}],'a'),'')
})
test('device diagnostics prove account/tenant/branch/endpoint registration and key match without leaking keys', async () => {
 const route=await read('app/api/push/staff/diagnostics/route.js')
 for(const pattern of [/authorizeDispatch/, /eq\('staff_id', ctx.staffId\)/,/eq\('tenant_id', ctx.tenantId\)/,/eq\('store_id', body.storeId\)/,/eq\('endpoint'/,/keysMatch/]) assert.match(route,pattern)
 assert.match(route,/Response.json\(\{ registered, keysMatch, configured:/)
 const ui=await read('components/dashboard/ManagerPushOptIn.js')
 for(const pattern of [/service-worker.js/,/reg\?\.active\?\.state === 'activated'/,/getSubscription/,/kind === 'reset'/,/subscription.unsubscribe/,/reset: true/,/subscription: subscription.toJSON\(\)/]) assert.match(ui,pattern)
})
test('test push targets exactly current device, reports provider failures and never confirms delivery', async () => {
 const route=await read('app/api/push/staff/test/route.js')
 assert.match(route,/row.staff_id === ctx.staffId && row.endpoint === subscription.endpoint/)
 assert.match(route,/row.p256dh !== subscription.keys\?\.p256dh/)
 assert.match(route,/deliveryConfirmed: false/)
 assert.match(route,/randomUUID\(\)/)
 assert.match(route,/failures.push/)
 assert.match(route,/isExpiredSubscription/)
})
test('POS and topbar have safe store links with dark drawer branch picker', async () => {
 const pos=await read('app/dashboard/pos/page.js'), top=await read('components/dashboard/TopBar.js'), links=await read('components/dashboard/BranchStoreLinks.js')
 assert.match(pos,/<StorefrontLink ctx=\{ctx\}/)
 assert.match(top,/<BranchStoreLinks ctx=\{ctx\}/)
 assert.match(links,/CustomSelect/)
 assert.match(links,/target="_blank" rel="noopener noreferrer"/)
 assert.doesNotMatch(links,/<select\b/)
 assert.doesNotMatch(links,/changeBranch\(/)
})
test('canonical worker is served as JS without caching at root scope', async () => {
 const config=await read('next.config.js')
 for(const pattern of [/source: '\/service-worker.js'/,/application\/javascript/,/no-cache, no-store, must-revalidate/,/Service-Worker-Allowed/]) assert.match(config,pattern)
})
async function loadTestRoute(rows, sendPush) {
 const source=(await read('app/api/push/staff/test/route.js')).replace(/^import .*$/gm,'').replace(/^export const runtime.*$/gm,'').replace('export async function POST','async function POST')
 const factory=new Function('authorizeDispatch','PushAuthError','staffSubscriptions','sendPush','pushConfigured','adminClient','randomUUID','isExpiredSubscription','buildOosPush',`${source}\nreturn POST`)
 return factory(async()=>({staffId:'me',tenantId:'tenant'}),class extends Error {},async()=>rows,sendPush,()=>true,()=>({from:()=>({delete:()=>({eq:async()=>({error:null})})})}),()=> 'unique-test',err=>err.statusCode===410,event=>event)
}
const subscription={endpoint:'https://fcm.googleapis.com/device',keys:{p256dh:'key',auth:'secret'}}
const row={id:'row',staff_id:'me',endpoint:subscription.endpoint,p256dh:'key',auth:'secret'}
const request=subscription=>new Request('https://example.com/api/push/staff/test',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({storeId:'branch',subscription})})
test('test route does not report another device acceptance as success', async () => {
 let calls=0
 const POST=await loadTestRoute([{...row,endpoint:'https://fcm.googleapis.com/other'}],async()=>{calls++})
 const response=await POST(request(subscription))
 assert.equal(response.status,409)
 assert.equal(calls,0)
})
test('test route sends only to current matching device, without delivery claim', async () => {
 const calls=[]
 const POST=await loadTestRoute([row,{...row,id:'other',endpoint:'https://fcm.googleapis.com/other'}],async sub=>calls.push(sub.id))
 const response=await POST(request(subscription)), result=await response.json()
 assert.equal(response.status,200)
 assert.deepEqual(calls,['row'])
 assert.equal(result.sent,1)
 assert.equal(result.deliveryConfirmed,false)
})
test('test route rejects stale device keys and exposes expired provider status safely', async () => {
 const mismatch=await loadTestRoute([row],async()=>assert.fail('must not send'))
 assert.equal((await mismatch(request({...subscription,keys:{...subscription.keys,auth:'stale'}}))).status,409)
 const expired=await loadTestRoute([row],async()=>{throw Object.assign(new Error('provider raw private body'),{statusCode:410})})
 const response=await expired(request(subscription)), result=await response.json()
 assert.equal(result.ok,false)
 assert.equal(result.sent,0)
 assert.equal(result.failures[0].status,410)
 assert.equal(JSON.stringify(result).includes('private'),false)
})

test('customer opt-in/out does not silently invalidate the manager browser endpoint', async () => {
 const ui=await read('components/store/PushOptIn.js')
 assert.match(ui,/previous \|\| await reg.pushManager.subscribe/)
 assert.doesNotMatch(ui,/(?:previous|subscription)\.unsubscribe\(/)
})
