import test from 'node:test'
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { getProvider } from '../lib/shipping/registry.js'
import { getAdapter, listTemplateAdapters } from '../lib/shipping/adapters.js'
import { resolveBaseUrl, shippingMode } from '../lib/shipping/transport.js'
import {
  resetShippingMock, listMockParcels, advanceMockParcel, getMockParcel, MOCK_BASE_URLS,
} from '../lib/shipping/mock.js'
import { csvText } from '../lib/access.js'
import { yalidineAdapter } from '../lib/shipping/providers/yalidine.js'
import { zrexpressAdapter } from '../lib/shipping/providers/zrexpress.js'
import { zrexpressnewAdapter } from '../lib/shipping/providers/zrexpressnew.js'

const MOCK_ENV = { SHIPPING_MOCK_MODE: 'true' }
const PROCOLIS_CREDENTIALS = { token: 'TOK-ZR', key: 'KEY-ZR' }
const NEW_CREDENTIALS = { apiKey: 'API-ZR-NEW', tenantId: 'tenant-7' }
const CONNECTION = { origin_wilaya_code: '16', defaults: { deliveryType: 'home' } }

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

test('P4: all three adapters share the same method contract and have CSV templates', () => {
  const methods = [
    'testConnection', 'createShipment', 'getTracking', 'getLabel', 'cancelShipment',
    'pullStatuses', 'syncTerritories', 'mapStatus', 'shipmentStatusFrom',
    'verifyWebhook', 'parseWebhook', 'buildBulkRows',
  ]
  const adapters = [yalidineAdapter, zrexpressAdapter, zrexpressnewAdapter]
  for (const adapter of adapters) {
    for (const method of methods) {
      assert.equal(typeof adapter[method], 'function', `${adapter.code}.${method}`)
    }
    for (const flag of [
      'create', 'track', 'label', 'cancel', 'webhook', 'pullStatuses', 'bulkTemplate', 'test',
    ]) {
      assert.equal(adapter.capabilities[flag], true, `${adapter.code}.${flag}`)
    }
    assert.equal(adapter.capabilities.fees, false)
  }
  assert.deepEqual(
    listTemplateAdapters().map(adapter => adapter.code),
    ['yalidine', 'zrexpress', 'zrexpressnew'],
  )
  assert.equal(getAdapter('ZREXPRESS'), zrexpressAdapter)
  assert.equal(getAdapter('zrexpressnew'), zrexpressnewAdapter)
})

test('each ZR platform has its own deterministic Mock Fetch origin', () => {
  for (const [code, url] of Object.entries(MOCK_BASE_URLS)) {
    assert.equal(shippingMode(MOCK_ENV, getProvider(code), 'sandbox'), 'mock')
    assert.equal(resolveBaseUrl(MOCK_ENV, getProvider(code), 'sandbox'), url)
  }
  assert.notEqual(MOCK_BASE_URLS.zrexpress, MOCK_BASE_URLS.zrexpressnew)
})

test('ZR Express / Procolis mock adapter covers the full lifecycle', async () => {
  resetShippingMock()
  const connected = await zrexpressAdapter.testConnection(PROCOLIS_CREDENTIALS, 'sandbox', MOCK_ENV)
  assert.equal(connected.ok, true, connected.message)
  assert.equal(connected.mode, 'mock')
  assert.equal(connected.httpStatus, 200)
  assert.match(connected.message, /بيانات وهمية/)

  const rejected = await zrexpressAdapter.testConnection(
    { token: 'invalid', key: 'x' }, 'sandbox', MOCK_ENV,
  )
  assert.equal(rejected.ok, false)
  assert.equal(rejected.code, 'AUTH_FAILED')

  const payload = zrexpressAdapter.buildShipmentPayload(request(), CONNECTION)
  assert.equal(payload.order_id, 'ORD-1001')
  assert.equal(payload.client, 'أحمد بن علي')
  assert.equal(payload.phone, '0555123456')
  assert.equal(payload.wilaya_id, 25)
  assert.equal(payload.wilaya_name, 'قسنطينة')
  assert.equal(payload.cod_amount, 5000)
  assert.equal(payload.delivery_fee, 500)
  assert.deepEqual(zrexpressAdapter.authHeaders(PROCOLIS_CREDENTIALS), {
    Authorization: 'Token TOK-ZR', 'X-Api-Key': 'KEY-ZR', Accept: 'application/json',
  })

  const created = await zrexpressAdapter.createShipment(request(), PROCOLIS_CREDENTIALS, {
    environment: 'sandbox', env: MOCK_ENV, connection: CONNECTION,
  })
  assert.match(created.trackingNumber, /^ZR-MOCK-[A-Z0-9]+-\d{4}$/)
  assert.equal(created.status, 'created')
  assert.equal(created.rawStatus, 'En attente')
  assert.equal(created.mode, 'mock')
  assert.match(created.labelUrl, /^data:image\/svg\+xml/)

  // Idempotent replay: a second create for the same platform/order reuses it.
  const replay = await zrexpressAdapter.createShipment(request(), PROCOLIS_CREDENTIALS, {
    environment: 'sandbox', env: MOCK_ENV, connection: CONNECTION,
  })
  assert.equal(replay.trackingNumber, created.trackingNumber)
  assert.equal(listMockParcels().length, 1)

  const tracking = await zrexpressAdapter.getTracking(created.trackingNumber, PROCOLIS_CREDENTIALS, {
    environment: 'sandbox', env: MOCK_ENV,
  })
  assert.equal(tracking.status, 'created')
  assert.equal(tracking.events.length, 1)

  advanceMockParcel(created.trackingNumber, 'En livraison', 'خرج للتسليم')
  const pulled = await zrexpressAdapter.pullStatuses(PROCOLIS_CREDENTIALS, {
    environment: 'sandbox', env: MOCK_ENV,
  })
  assert.equal(pulled.mode, 'mock')
  assert.equal(pulled.parcels.length, 1)
  assert.equal(pulled.parcels[0].status, 'in_transit')

  const label = await zrexpressAdapter.getLabel(created.trackingNumber, PROCOLIS_CREDENTIALS, {
    environment: 'sandbox', env: MOCK_ENV,
  })
  assert.equal(label.labelUrl, created.labelUrl)

  const territories = await zrexpressAdapter.syncTerritories(PROCOLIS_CREDENTIALS, {
    environment: 'sandbox', env: MOCK_ENV,
  })
  assert.equal(territories.mode, 'mock')
  assert.equal(territories.territories.length, 58)
  assert.equal(territories.territories.find(row => row.wilayaCode === '25').name, 'قسنطينة')

  const cancelled = await zrexpressAdapter.cancelShipment(created.trackingNumber, PROCOLIS_CREDENTIALS, {
    environment: 'sandbox', env: MOCK_ENV,
  })
  assert.equal(cancelled.status, 'cancelled')
  assert.equal(getMockParcel(created.trackingNumber)?.last_status, 'Annulé')

  assert.equal(zrexpressAdapter.mapStatus('Livré'), 'delivered')
  assert.equal(zrexpressAdapter.mapStatus('Annulé'), 'cancelled')
  assert.equal(zrexpressAdapter.mapStatus('حالة جديدة'), 'unknown')
  assert.equal(zrexpressAdapter.shipmentStatusFrom('unknown', 'created'), 'created')
})

test('ZR Express new-platform mock adapter covers the full lifecycle', async () => {
  resetShippingMock()
  const connected = await zrexpressnewAdapter.testConnection(NEW_CREDENTIALS, 'sandbox', MOCK_ENV)
  assert.equal(connected.ok, true, connected.message)
  assert.equal(connected.mode, 'mock')

  const rejected = await zrexpressnewAdapter.testConnection(
    { apiKey: 'invalid', tenantId: 'x' }, 'sandbox', MOCK_ENV,
  )
  assert.equal(rejected.code, 'AUTH_FAILED')

  const payload = zrexpressnewAdapter.buildShipmentPayload(request(), CONNECTION)
  assert.equal(payload.orderId, 'ORD-1001')
  assert.equal(payload.recipient, 'أحمد بن علي')
  assert.equal(payload.phone, '0555123456')
  assert.match(payload.territoryId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-a[0-9a-f]{3}-[0-9a-f]{12}$/)
  assert.equal(payload.codAmount, 5000)
  assert.equal(payload.deliveryFee, 500)
  assert.match(payload.productList, /قميص/)
  assert.deepEqual(zrexpressnewAdapter.authHeaders(NEW_CREDENTIALS), {
    'X-Api-Key': 'API-ZR-NEW', 'X-Tenant': 'tenant-7', Accept: 'application/json',
  })

  const created = await zrexpressnewAdapter.createShipment(request(), NEW_CREDENTIALS, {
    environment: 'sandbox', env: MOCK_ENV, connection: CONNECTION,
  })
  assert.match(created.trackingNumber, /^ZRN-MOCK-[A-Z0-9]+-\d{4}$/)
  assert.match(created.externalId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-a[0-9a-f]{3}-[0-9a-f]{12}$/)
  assert.equal(created.rawStatus, 'pending')
  assert.equal(created.mode, 'mock')
  assert.match(created.labelUrl, /^data:image\/svg\+xml/)

  const tracking = await zrexpressnewAdapter.getTracking(created.trackingNumber, NEW_CREDENTIALS, {
    environment: 'sandbox', env: MOCK_ENV,
  })
  assert.equal(tracking.status, 'created')
  assert.equal(tracking.rawStatus, 'pending')

  const label = await zrexpressnewAdapter.getLabel(created.trackingNumber, NEW_CREDENTIALS, {
    environment: 'sandbox', env: MOCK_ENV,
  })
  assert.equal(label.labelUrl, created.labelUrl)

  advanceMockParcel(created.trackingNumber, 'in_transit', 'في الطريق')
  const pulledStatuses = await zrexpressnewAdapter.pullStatuses(NEW_CREDENTIALS, {
    environment: 'sandbox', env: MOCK_ENV,
  })
  assert.equal(pulledStatuses.parcels[0].status, 'in_transit')

  const territories = await zrexpressnewAdapter.syncTerritories(NEW_CREDENTIALS, {
    environment: 'sandbox', env: MOCK_ENV,
  })
  assert.equal(territories.territories.length, 58)
  assert.equal(territories.territories.find(row => row.wilayaCode === '25').communeName, 'Centre Ville')
  assert.match(
    territories.territories.find(row => row.wilayaCode === '25').externalId,
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-a[0-9a-f]{3}-[0-9a-f]{12}$/,
  )

  const cancelled = await zrexpressnewAdapter.cancelShipment(created.trackingNumber, NEW_CREDENTIALS, {
    environment: 'sandbox', env: MOCK_ENV,
  })
  assert.equal(cancelled.status, 'cancelled')
  assert.equal(getMockParcel(created.trackingNumber)?.last_status, 'cancelled')

  assert.equal(zrexpressnewAdapter.mapStatus('delivered'), 'delivered')
  assert.equal(zrexpressnewAdapter.mapStatus('returned'), 'returned')
  assert.equal(zrexpressnewAdapter.mapStatus('ملغى'), 'cancelled')
})

test('ZR webhooks verify the exact raw body and parse canonical events', () => {
  const secret = 'zr-unit-test-secret'
  const rawBody = JSON.stringify({
    events: [{ tracking: 'ZR-MOCK-TEST-1001', status: 'Livré', at: '2026-11-13T12:00:00Z' }],
  })
  const signature = createHmac('sha256', secret).update(rawBody).digest('hex')
  for (const adapter of [zrexpressAdapter, zrexpressnewAdapter]) {
    assert.equal(adapter.verifyWebhook(rawBody, { 'X-ZR-Signature': signature }, secret), true)
    assert.equal(adapter.verifyWebhook(rawBody, { 'x-zr-signature': `sha256=${signature}` }, secret), true)
    assert.equal(adapter.verifyWebhook(`${rawBody} `, { 'X-ZR-Signature': signature }, secret), false)
    assert.equal(adapter.verifyWebhook(rawBody, {}, secret), false)
    assert.equal(adapter.verifyWebhook(rawBody, { 'X-ZR-Signature': signature }, ''), false)
    const events = adapter.parseWebhook(JSON.parse(rawBody))
    assert.equal(events.length, 1)
    assert.equal(events[0].trackingNumber, 'ZR-MOCK-TEST-1001')
    assert.equal(events[0].canonicalStatus, 'delivered')
    assert.equal(events[0].occurredAt, '2026-11-13T12:00:00Z')
  }
})

test('all company CSV templates are Arabic, BOM-safe and injection-safe', () => {
  const requests = [
    request(),
    request({
      orderId: '22222222-2222-4222-8222-222222222222',
      orderNumber: 'ORD-1002',
      customerName: 'فاطمة الزهراء',
      customerPhone: '0666123456',
      note: '=SUM(1+1)',
    }),
  ]
  for (const adapter of listTemplateAdapters()) {
    const built = adapter.buildBulkRows({
      requests, connection: CONNECTION, environment: 'sandbox',
    })
    assert.equal(built.rows.length, 2, `${adapter.code} row count`)
    assert.ok(built.columns.length >= 10, `${adapter.code} columns`)
    assert.ok(
      built.columns.every(column => /[\u0600-\u06FF]/.test(column.label)),
      `${adapter.code} Arabic headers`,
    )
    assert.match(built.templateVersion, /-v1$/)
    assert.ok(built.filePrefix)

    const csv = csvText(built.columns, built.rows)
    assert.equal(csv.charCodeAt(0), 0xFEFF, `${adapter.code} UTF-8 BOM`)
    assert.match(csv, /"أحمد/)
    assert.match(csv, /"فاطمة/)
    assert.match(csv, /"0555123456"|"0555123456"/)
    assert.ok(csv.includes('\r\n'), `${adapter.code} CRLF rows`)
    // csvText() neutralises spreadsheet formulas; no library was added.
    assert.match(csv, /"'=SUM\(1\+1\)"/)
  }
})
