import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'

const read = file => fs.readFile(new URL(`../${file}`, import.meta.url), 'utf8')
const { vapidConfig, publicVapidKey, pushConfigured } = await import('../lib/push/config.js')
const {
  normalizeSubscription, normalizePushKind, isValidUuid,
} = await import('../lib/push/subscription.js')
const { buildPushMessage, safeOrigin } = await import('../lib/push/notification.js')

const PUBLIC_KEY = 'A'.repeat(87)
const PRIVATE_KEY = 'B'.repeat(43)
const SUBJECT = 'mailto:support@vetrina.app'

// المرحلة 6: branch-scoped Web Push subscriptions and automatic dispatch.
test('VAPID config accepts base64 JSON and never exposes the private key', t => {
  const saved = {
    config: process.env.PUSH_VAPID_CONFIG,
    pub: process.env.PUSH_VAPID_PUBLIC_KEY,
    priv: process.env.PUSH_VAPID_PRIVATE_KEY,
    subject: process.env.PUSH_VAPID_SUBJECT,
  }
  t.after(() => {
    for (const [key, value] of Object.entries(saved)) {
      const envKey = { config: 'PUSH_VAPID_CONFIG', pub: 'PUSH_VAPID_PUBLIC_KEY', priv: 'PUSH_VAPID_PRIVATE_KEY', subject: 'PUSH_VAPID_SUBJECT' }[key]
      if (value === undefined) delete process.env[envKey]
      else process.env[envKey] = value
    }
  })

  process.env.PUSH_VAPID_CONFIG = Buffer.from(JSON.stringify({
    publicKey: PUBLIC_KEY, privateKey: PRIVATE_KEY, subject: SUBJECT,
  })).toString('base64')
  assert.deepEqual(vapidConfig(), { publicKey: PUBLIC_KEY, privateKey: PRIVATE_KEY, subject: SUBJECT })
  assert.equal(publicVapidKey(), PUBLIC_KEY)
  assert.equal(pushConfigured(), true)

  process.env.PUSH_VAPID_CONFIG = JSON.stringify({
    publicKey: PUBLIC_KEY, privateKey: PRIVATE_KEY, subject: SUBJECT,
  })
  assert.equal(vapidConfig().publicKey, PUBLIC_KEY)

  process.env.PUSH_VAPID_CONFIG = 'not-a-config'
  assert.equal(vapidConfig(), null)

  delete process.env.PUSH_VAPID_CONFIG
  process.env.PUSH_VAPID_PUBLIC_KEY = PUBLIC_KEY
  process.env.PUSH_VAPID_PRIVATE_KEY = PRIVATE_KEY
  process.env.PUSH_VAPID_SUBJECT = SUBJECT
  assert.equal(vapidConfig().privateKey, PRIVATE_KEY)
})

test('customer subscriptions are validated and scoped to one branch', () => {
  const valid = normalizeSubscription({
    endpoint: 'https://fcm.googleapis.com/fcm/send/abc123',
    keys: { p256dh: 'p256dh-value', auth: 'auth-value' },
  })
  assert.equal(valid.endpoint, 'https://fcm.googleapis.com/fcm/send/abc123')
  assert.throws(() => normalizeSubscription({
    endpoint: 'http://example.com', keys: { p256dh: 'x', auth: 'y' },
  }), /https/)
  assert.throws(() => normalizeSubscription({
    endpoint: 'javascript:alert(1)', keys: { p256dh: 'x', auth: 'y' },
  }), /غير صالح/)
  assert.throws(() => normalizeSubscription({
    endpoint: 'https://example.com', keys: { p256dh: '', auth: '' },
  }), /مفاتيح/)
  assert.equal(normalizePushKind('offer'), 'offer')
  assert.equal(normalizePushKind('product'), 'product')
  assert.equal(isValidUuid('11111111-1111-4111-8111-111111111111'), true)
  assert.equal(isValidUuid('not-a-uuid'), false)
})

test('notification copy carries store name, catchy title and a direct link', () => {
  const message = buildPushMessage({
    storeName: 'بوتيك النور',
    storeSlug: 'myshop',
    origin: 'https://vetrina.example/',
    kind: 'offer',
    itemName: 'خصم الصيف',
    logoUrl: 'https://cdn.example/logo.png',
    now: 123,
  })
  assert.match(message.title, /بوتيك النور/)
  assert.match(message.title, /عرض جديد/)
  assert.match(message.body, /https:\/\/vetrina\.example\/s\/myshop/)
  assert.equal(message.url, 'https://vetrina.example/s/myshop')
  assert.equal(message.data.url, message.url)
  assert.equal(message.icon, 'https://cdn.example/logo.png')
  assert.equal(message.tag, 'vetrina-myshop-offer-123')
  assert.equal(safeOrigin('javascript:alert(1)'), '')
  assert.equal(safeOrigin('https://vetrina.example/path'), 'https://vetrina.example')
})

test('server routes dispatch only to the authorised branch after new product/offer', async () => {
  const dispatch = await read('app/api/push/dispatch/route.js')
  const subscribe = await read('app/api/push/subscribe/route.js')
  const publicKeyRoute = await read('app/api/push/public-key/route.js')
  const store = await read('lib/push/store.js')
  const authorize = await read('lib/push/authorize.js')
  const client = await read('lib/push/client.js')
  const products = await read('app/dashboard/_screens/products.js')
  const offers = await read('app/dashboard/_screens/offers.js')
  const sql = await read('supabase/migrations/202611130019_branch_specialty_themes_and_push.sql')
  const env = await read('.env.example')
  const pkg = JSON.parse(await read('package.json'))

  assert.match(dispatch, /authorizeDispatch\(request, storeId\)/)
  assert.match(dispatch, /subscriptionsForStore\(storeId\)/)
  assert.match(dispatch, /buildPushMessage/)
  assert.match(dispatch, /sendPush\(subscription, message\)/)
  assert.match(dispatch, /deleteSubscriptions\(expired\)/)
  assert.match(subscribe, /saveSubscription\(slug, subscription/)
  assert.match(subscribe, /normalizeSubscription/)
  assert.match(publicKeyRoute, /publicVapidKey\(\)/)
  assert.doesNotMatch(publicKeyRoute, /privateKey/)
  assert.match(store, /\.eq\('store_id', storeId\)/)
  assert.match(store, /onConflict: 'endpoint'/)
  assert.match(store, /get_store_by_slug/)
  assert.match(authorize, /engine_session/)
  assert.match(authorize, /engine_staff/)
  assert.match(authorize, /ctx\.stores\.some\(store => store\.id === storeId\)/)
  assert.match(client, /Authorization: `Bearer \$\{token\}`/)
  assert.match(client, /\/api\/push\/dispatch/)
  assert.doesNotMatch(client, /SERVICE_ROLE/i)
  assert.match(products, /notifyBranchPush\(\{ storeId: ctx\.storeId, kind: 'product'/)
  assert.match(offers, /notifyBranchPush\(\{ storeId: ctx\?\.storeId, kind: 'offer'/)
  assert.match(sql, /CREATE TABLE IF NOT EXISTS public\.push_subscriptions/)
  assert.match(sql, /store_id\s+uuid NOT NULL REFERENCES public\.stores\(id\)/)
  assert.match(sql, /ENABLE ROW LEVEL SECURITY/)
  assert.match(sql, /REVOKE ALL ON TABLE public\.push_subscriptions FROM PUBLIC, anon, authenticated/)
  assert.match(sql, /GRANT ALL ON TABLE public\.push_subscriptions TO service_role/)
  assert.match(env, /PUSH_VAPID_CONFIG/)
  assert.ok(pkg.dependencies['web-push'])
})
