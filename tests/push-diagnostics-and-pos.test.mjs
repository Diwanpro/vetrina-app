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
