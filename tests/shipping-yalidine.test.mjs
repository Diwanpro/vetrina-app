import test from 'node:test'
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { getProvider } from '../lib/shipping/registry.js'
import { getAdapter, listAdapterCodes } from '../lib/shipping/adapters.js'
import { shippingMode, resolveBaseUrl, shippingRequest } from '../lib/shipping/transport.js'
import {
  resetShippingMock, listMockParcels, advanceMockParcel,
} from '../lib/shipping/mock.js'
import { yalidineWilayaName } from '../lib/shipping/wilayaNames.js'
import {
  yalidineAdapter, mapStatus, shipmentStatusFrom, authHeaders, buildShipmentPayload,
} from '../lib/shipping/providers/yalidine.js'

const PROVIDER = getProvider('yalidine')
const CREDENTIALS = { apiId: 'ID-7', apiToken: 'TOK-9' }
const MOCK_ENV = { SHIPPING_MOCK_MODE: 'true' }

function request(overrides = {}) {
  return {
    orderId: '11111111-1111-4111-8111-111111111111',
    orderNumber: 'ORD-1001',
    customerName: 'أحمد بن علي',
    customerPhone: '0555 12 34 56',
    wilayaCode: '25',
    commune: 'Centre Ville',
    address: 'شارع الأمير عبد القادر، قسنطينة',
    note: 'اتصال قبل التسليم',
    codAmount: 5000,
    deliveryFee: 500,
    items: [{ product_name: 'قميص', qty: 2, unit_price: 2000, size: 'L', color: 'أزرق' }],
    deliveryType: 'home',
    ...overrides,
  }
}

test('the P4 adapter registry exposes Yalidine and both ZR platforms', () => {
  assert.deepEqual(listAdapterCodes(), ['yalidine', 'zrexpress', 'zrexpressnew'])
  assert.equal(getAdapter('YALIDINE'), yalidineAdapter)
  assert.equal(getAdapter('ZREXPRESS')?.code, 'zrexpress')
  assert.equal(getAdapter('zrexpressnew')?.code, 'zrexpressnew')
  for (const flag of [
    'create', 'track', 'label', 'cancel', 'webhook', 'pullStatuses', 'bulkTemplate', 'test',
  ]) {
    assert.equal(yalidineAdapter.capabilities[flag], true)
  }
  assert.equal(yalidineAdapter.capabilities.fees, false)
})

test('transport switches between offline mock and live without adapter changes', () => {
  assert.equal(shippingMode(MOCK_ENV, PROVIDER, 'sandbox'), 'mock')
  assert.equal(shippingMode({ SHIPPING_MOCK_MODE: 'false' }, PROVIDER, 'sandbox'), 'live')
  assert.equal(shippingMode({}, PROVIDER, 'sandbox'), 'mock')
  assert.equal(shippingMode({ SHIPPING_YALIDINE_SANDBOX_BASE_URL: 'https://api.example.test/v1/' }, PROVIDER, 'sandbox'), 'live')
  assert.match(resolveBaseUrl(MOCK_ENV, PROVIDER, 'sandbox'), /^https:\/\/mock\.yalidine\.local\/v1\/$/)
  assert.equal(
    resolveBaseUrl({ SHIPPING_YALIDINE_PRODUCTION_BASE_URL: 'https://prod.example.test/v1' }, PROVIDER, 'production'),
    'https://prod.example.test/v1',
  )
  assert.equal(resolveBaseUrl({ SHIPPING_MOCK_MODE: 'false' }, PROVIDER, 'sandbox'), 'https://api.yalidine.app/v1/')
})

test('canonical statuses and Yalidine parcel payload are deterministic', () => {
  assert.equal(mapStatus('Créé'), 'created')
  assert.equal(mapStatus('En livraison'), 'in_transit')
  assert.equal(mapStatus('Livré'), 'delivered')
  assert.equal(mapStatus('Retourné'), 'returned')
  assert.equal(mapStatus('Annulé'), 'cancelled')
  assert.equal(mapStatus('حالة جديدة'), 'unknown')
  assert.equal(shipmentStatusFrom('unknown', 'created'), 'created')
  assert.equal(yalidineWilayaName('25'), 'Constantine')
  assert.equal(yalidineWilayaName('16'), 'Alger')

  const payload = buildShipmentPayload(request(), { originWilayaCode: '16' })
  assert.equal(payload.order_id, 'ORD-1001')
  assert.equal(payload.firstname, 'أحمد')
  assert.equal(payload.familyname, 'بن علي')
  assert.equal(payload.contact_phone, '0555123456')
  assert.equal(payload.to_wilaya_name, 'Constantine')
  assert.equal(payload.from_wilaya_name, 'Alger')
  assert.equal(payload.to_commune_name, 'Centre Ville')
  assert.equal(payload.price, 5000)
  assert.equal(payload.delivery_fee, 500)
  assert.equal(payload.is_stopdesk, false)
  assert.match(payload.product_list, /قميص/)
  assert.deepEqual(authHeaders(CREDENTIALS), {
    'X-API-ID': 'ID-7', 'X-API-TOKEN': 'TOK-9', Accept: 'application/json',
  })
})

test('Mock Fetch covers test/create/tracking/label/cancel/statuses/territories', async () => {
  resetShippingMock()
  const connection = { originWilayaCode: '16' }

  const connected = await yalidineAdapter.testConnection(CREDENTIALS, 'sandbox', MOCK_ENV)
  assert.equal(connected.ok, true)
  assert.equal(connected.mode, 'mock')
  assert.equal(connected.httpStatus, 200)
  assert.match(connected.message, /بيانات وهمية/)

  const rejected = await yalidineAdapter.testConnection({ apiId: 'invalid', apiToken: 'x' }, 'sandbox', MOCK_ENV)
  assert.equal(rejected.ok, false)
  assert.equal(rejected.code, 'AUTH_FAILED')

  const created = await yalidineAdapter.createShipment(request(), CREDENTIALS, {
    environment: 'sandbox', env: MOCK_ENV, connection,
  })
  assert.match(created.trackingNumber, /^YAL-MOCK-[A-Z0-9]+-\d{4}$/)
  assert.equal(created.status, 'created')
  assert.equal(created.mode, 'mock')
  assert.match(created.labelUrl, /^data:image\/svg\+xml/)

  // Replaying the same order is idempotent: no second parcel is created.
  const replay = await yalidineAdapter.createShipment(request(), CREDENTIALS, {
    environment: 'sandbox', env: MOCK_ENV, connection,
  })
  assert.equal(replay.trackingNumber, created.trackingNumber)
  assert.equal(listMockParcels().length, 1)

  const tracking = await yalidineAdapter.getTracking(created.trackingNumber, CREDENTIALS, {
    environment: 'sandbox', env: MOCK_ENV,
  })
  assert.equal(tracking.status, 'created')
  assert.equal(tracking.rawStatus, 'Créé')
  assert.equal(tracking.events.length, 1)

  advanceMockParcel(created.trackingNumber, 'En livraison', 'خرج للتسليم')
  const inTransit = await yalidineAdapter.getTracking(created.trackingNumber, CREDENTIALS, {
    environment: 'sandbox', env: MOCK_ENV,
  })
  assert.equal(inTransit.status, 'in_transit')
  assert.equal(inTransit.events.length, 2)

  const label = await yalidineAdapter.getLabel(created.trackingNumber, CREDENTIALS, {
    environment: 'sandbox', env: MOCK_ENV,
  })
  assert.equal(label.labelUrl, created.labelUrl)

  const pulled = await yalidineAdapter.pullStatuses(CREDENTIALS, { environment: 'sandbox', env: MOCK_ENV })
  assert.equal(pulled.mode, 'mock')
  assert.equal(pulled.parcels.length, 1)
  assert.equal(pulled.parcels[0].status, 'in_transit')

  const territories = await yalidineAdapter.syncTerritories(CREDENTIALS, { environment: 'sandbox', env: MOCK_ENV })
  assert.equal(territories.territories.length, 58)
  assert.equal(territories.territories.find(row => row.wilayaCode === '25').name, 'قسنطينة')

  const cancelled = await yalidineAdapter.cancelShipment(created.trackingNumber, CREDENTIALS, {
    environment: 'sandbox', env: MOCK_ENV,
  })
  assert.equal(cancelled.status, 'cancelled')
  const afterCancel = await yalidineAdapter.getTracking(created.trackingNumber, CREDENTIALS, {
    environment: 'sandbox', env: MOCK_ENV,
  })
  assert.equal(afterCancel.status, 'cancelled')
})

test('webhook verification uses the exact raw body and parses events', () => {
  const secret = 'unit-test-secret'
  const rawBody = '{"events":[{"tracking":"YAL-MOCK-ABC-1001","status":"Livré","at":"2026-11-13T12:00:00Z"}]}'
  const signature = createHmac('sha256', secret).update(rawBody).digest('hex')
  assert.equal(yalidineAdapter.verifyWebhook(rawBody, { 'X-Yalidine-Signature': signature }, secret), true)
  assert.equal(yalidineAdapter.verifyWebhook(rawBody, { 'x-yalidine-signature': `sha256=${signature}` }, secret), true)
  assert.equal(yalidineAdapter.verifyWebhook(`${rawBody} `, { 'X-Yalidine-Signature': signature }, secret), false)
  assert.equal(yalidineAdapter.verifyWebhook(rawBody, {}, secret), false)
  assert.equal(yalidineAdapter.verifyWebhook(rawBody, { 'X-Yalidine-Signature': signature }, ''), false)

  const events = yalidineAdapter.parseWebhook(JSON.parse(rawBody))
  assert.equal(events.length, 1)
  assert.equal(events[0].trackingNumber, 'YAL-MOCK-ABC-1001')
  assert.equal(events[0].canonicalStatus, 'delivered')
  assert.equal(events[0].occurredAt, '2026-11-13T12:00:00Z')
})

test('HTTP failures keep the shared Arabic error taxonomy', async () => {
  const env = {
    SHIPPING_MOCK_MODE: 'false',
    SHIPPING_YALIDINE_SANDBOX_BASE_URL: 'https://api.example.test/v1/',
  }
  const failWith = status => async () => new Response(JSON.stringify({ message: 'nope' }), {
    status, headers: { 'Content-Type': 'application/json' },
  })
  for (const [status, code] of [[401, 'AUTH_FAILED'], [429, 'RATE_LIMITED'], [422, 'VALIDATION_ERROR'], [404, 'NOT_FOUND'], [500, 'PROVIDER_ERROR']]) {
    await assert.rejects(
      () => shippingRequest({
        provider: PROVIDER, environment: 'sandbox', path: 'parcels', method: 'GET',
        env, fetchImpl: failWith(status),
      }),
      error => error.name === 'ShippingError' && error.code === code,
    )
  }
})
