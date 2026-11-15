import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { eligibleStaff, buildOosPush, validStaffEndpoint } from '../lib/push/staff.js'
const read = p => fs.readFile(new URL(`../${p}`, import.meta.url), 'utf8')
const sub = { staff_id: 'staff', tenant_id: 'tenant', store_id: 'branch' }
const user = { id: 'staff', tenant_id: 'tenant', store_id: 'branch', role: 'manager', is_active: true }
test('OOS recipients: assigned manager or tenant owner only, never employee/inactive/cross-tenant', () => {
 assert.equal(eligibleStaff(user, sub), true)
 assert.equal(eligibleStaff({...user, role:'owner',store_id:'other'},sub),true)
 for (const change of [{role:'employee'}, {role:'manager',store_id:'other'}, {tenant_id:'other'}, {is_active:false}, {id:'other'}]) assert.equal(eligibleStaff({...user,...change},sub),false)
 assert.equal(eligibleStaff(null,sub),false)
})
test('staff endpoint allowlist rejects SSRF targets', () => {
 assert.equal(validStaffEndpoint('https://fcm.googleapis.com/fcm/send/test'),true)
 assert.equal(validStaffEndpoint('https://web.push.apple.com/test'),true)
 assert.equal(validStaffEndpoint('https://updates.push.services.mozilla.com/wpush/test'),true)
 for (const url of ['http://fcm.googleapis.com/x','https://localhost/x','https://127.0.0.1/x','https://fcm.googleapis.com.evil.com/x','https://user:pass@fcm.googleapis.com/x','https://fcm.googleapis.com:444/x']) assert.equal(validStaffEndpoint(url),false)
})
test('OOS payload has Arabic product size/color and safe dashboard action', () => {
 const event={id:'event',store_id:'branch',store_name:'الفرع الشرقي',product_name:'فستان سهرة',size:'M',color:'أحمر'}
 const result=buildOosPush(event)
 for(const text of ['فستان سهرة','M','أحمر']) assert.ok(result.body.includes(text))
 assert.equal(result.data.url,'/dashboard/alerts?store=branch')
 assert.equal(result.actions[0].title,'فتح التنبيهات')
 assert.equal(result.tag,'oos-event')
 assert.equal(buildOosPush({...event,product_name:'x'.repeat(1000)}).body.length<400,true)
})
test('database produces push without browser and retries via cron; service-only capabilities and leases', async () => {
 const sql=await read('supabase/migrations/202611130021_manager_oos_push.sql')
 for(const pattern of [/OLD.quantity>0 AND NEW.quantity=0/, /net.http_post/, /cron.schedule/, /FOR UPDATE SKIP LOCKED/, /token=p_token/, /locked_until=now\(\)\+interval '2 minutes'/, /ENABLE ROW LEVEL SECURITY/, /FROM PUBLIC,anon,authenticated/, /attempts<100/]) assert.match(sql,pattern)
 assert.doesNotMatch(sql,/(?:ALTER TABLE|UPDATE|INSERT INTO|DELETE FROM) public.orders\b/i)
})
test('opt-in and test enforce staff authorization and use separate subscription table', async () => {
 const subscribe=await read('app/api/push/staff/subscribe/route.js')
 const dispatch=await read('app/api/push/oos/route.js')
 const testRoute=await read('app/api/push/staff/test/route.js')
 assert.match(subscribe,/authorizeDispatch\(request, body.storeId\)/)
 assert.match(subscribe,/staff_id: ctx.staffId/)
 assert.match(subscribe,/staff_push_subscriptions/)
 assert.match(testRoute,/row.staff_id === ctx.staffId/)
 assert.match(dispatch,/claim_oos_push/)
 assert.match(dispatch,/staffSubscriptions\(event.store_id, event.tenant_id\)/)
 assert.match(dispatch,/isExpiredSubscription/)
 assert.doesNotMatch(dispatch,/notifyBranchPush/)
})
test('service worker action opens alerts; staff UI shares existing browser subscription', async () => {
 const sw=await read('public/service-worker.js')
 const ui=await read('components/dashboard/ManagerPushOptIn.js')
 assert.match(sw,/url.startsWith\('\/dashboard\/alerts'\)/)
 assert.match(ui,/getSubscription\(\)/)
 assert.doesNotMatch(ui,/\.unsubscribe\(\)/)
 assert.doesNotMatch(ui,/<select\b/)
})
test('real Web Push sender encrypts payload and sets VAPID/high priority (local transport, not a phone)', async () => {
 const { createServer, globalAgent } = await import('node:https')
 const { execFileSync } = await import('node:child_process')
 const { tmpdir } = await import('node:os')
 const directory=await fs.mkdtemp(`${tmpdir()}/vetrina-push-tls-`)
 execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',`${directory}/key.pem`,'-out',`${directory}/cert.pem`,'-days','1','-subj','/CN=127.0.0.1','-addext','subjectAltName=IP:127.0.0.1'],{stdio:'ignore'})
 const key=await fs.readFile(`${directory}/key.pem`), cert=await fs.readFile(`${directory}/cert.pem`)
 const previousCa=globalAgent.options.ca
 globalAgent.options.ca=cert
 const { createECDH, randomBytes } = await import('node:crypto')
 const webpush = await import('web-push')
 const { sendPush } = await import('../lib/push/sender.js')
 const old = process.env.PUSH_VAPID_CONFIG
 const vapid = webpush.generateVAPIDKeys()
 process.env.PUSH_VAPID_CONFIG = JSON.stringify({...vapid, subject:'mailto:test@example.com'})
 const client = createECDH('prime256v1'); client.generateKeys()
 let received
 const server = createServer({key,cert}, (req, res) => {
   const chunks=[]
   req.on('data', chunk => chunks.push(chunk))
   req.on('end', () => { received={headers:req.headers,body:Buffer.concat(chunks)}; res.writeHead(201); res.end() })
 })
 try {
   await new Promise(resolve => server.listen(0, '0.0.0.0', resolve))
   const response=await sendPush({endpoint:`https://127.0.0.1:${server.address().port}/push`,p256dh:client.getPublicKey().toString('base64url'),auth:randomBytes(16).toString('base64url')},buildOosPush({id:'transport',store_id:'branch',product_name:'فستان',color:'أحمر',size:'M'}))
   assert.equal(response.statusCode,201)
   assert.equal(received.headers.urgency,'high')
   assert.equal(received.headers['content-encoding'],'aes128gcm')
   assert.match(received.headers.authorization,/vapid/)
   assert.equal(received.body.includes(Buffer.from('فستان')),false)
 } finally {
   await new Promise(resolve => server.close(resolve))
   globalAgent.options.ca=previousCa
   await fs.rm(directory,{recursive:true,force:true})
   if (old === undefined) delete process.env.PUSH_VAPID_CONFIG
   else process.env.PUSH_VAPID_CONFIG=old
 }
})
