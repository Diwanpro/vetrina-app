import test from 'node:test'
import assert from 'node:assert/strict'
import { createHmac, randomUUID } from 'node:crypto'
import {
  shipOrder, syncShipment, cancelShipment, handleShippingWebhook,
} from '../lib/shipping/index.js'
import { encryptCredentials, connectionAad } from '../lib/shipping/credentials.js'
import { resetShippingMock, advanceMockParcel, getMockParcel } from '../lib/shipping/mock.js'

const TENANT_ID = '11111111-1111-4111-8111-111111111111'
const STORE_ID = '22222222-2222-4222-8222-222222222222'
const ORDER_ID = '33333333-3333-4333-8333-333333333333'
const STAFF_ID = '44444444-4444-4444-8444-444444444444'
const CONNECTION_ID = '55555555-5555-4555-8555-555555555555'

class FakeQuery {
  constructor(state, table) {
    this.state = state
    this.table = table
    this.filters = []
    this.action = null
    this.payload = null
    this.result = null
    this.insertError = null
    this.applied = false
  }

  rows() {
    const map = {
      shipping_connections: this.state.connections,
      shipments: this.state.shipments,
      shipment_events: this.state.events,
    }
    return map[this.table] || []
  }

  select() { return this }
  eq(key, value) {
    this.filters.push([key, 'eq', value])
    if (this.action === 'update' && key === 'id') this.applyUpdate()
    return this
  }
  in(key, values) {
    this.filters.push([key, 'in', values])
    return this
  }
  matches(row) {
    return this.filters.every(([key, op, value]) => (
      op === 'eq' ? row[key] === value : Array.isArray(value) && value.includes(row[key])
    ))
  }
  insert(payload) {
    this.action = 'insert'
    this.payload = payload
    if (this.table === 'shipments' && this.rows().some(row => row.idempotency_key === payload.idempotency_key)) {
      this.insertError = { code: '23505', message: 'duplicate idempotency key' }
      return this
    }
    this.result = { id: randomUUID(), ...payload }
    this.rows().push(this.result)
    return this
  }
  update(payload) {
    this.action = 'update'
    this.payload = payload
    return this
  }
  upsert(payload) {
    this.action = 'upsert'
    this.payload = payload
    if (this.table === 'shipment_events') {
      const exists = this.state.events.some(row => (
        row.provider_code === payload.provider_code && row.event_key === payload.event_key
      ))
      if (!exists) this.state.events.push({ id: randomUUID(), ...payload })
    }
    return this
  }
  applyUpdate() {
    if (this.applied || this.action !== 'update') return
    this.applied = true
    for (const row of this.rows().filter(entry => this.matches(entry))) {
      Object.assign(row, this.payload)
    }
  }
  async maybeSingle() {
    this.applyUpdate()
    return { data: this.rows().find(row => this.matches(row)) || null, error: null }
  }
  async single() {
    if (this.action === 'insert') return { data: this.result, error: this.insertError }
    this.applyUpdate()
    return { data: this.rows().find(row => this.matches(row)) || null, error: null }
  }
  // Supabase query builders are thenable: `await query.select(...).eq(...)`.
  // The gateway uses that form to count previous shipping attempts.
  then(resolve, reject) {
    try {
      this.applyUpdate()
      resolve({ data: this.rows().filter(row => this.matches(row)), error: null })
    } catch (error) { reject(error) }
  }
}

class FakeAdmin {
  constructor(state) { this.state = state }
  from(table) {
    this.state.tablesUsed.add(table)
    return new FakeQuery(this.state, table)
  }
}

function makeState(connectionRow, snapshot) {
  return {
    connections: [connectionRow],
    shipments: [],
    events: [],
    tablesUsed: new Set(),
    rpcCalls: [],
    snapshot,
  }
}

function makeUserClient(state) {
  return {
    rpc: async (name, args) => {
      state.rpcCalls.push({ name, args })
      if (name === 'engine_order_shipping_snapshot') return { data: state.snapshot, error: null }
      return { data: null, error: null }
    },
  }
}

test('P3 gateway ships, syncs, verifies webhooks and cancels without touching orders', async (t) => {
  const originalMasterKey = process.env.SHIPPING_MASTER_KEY
  const originalMockMode = process.env.SHIPPING_MOCK_MODE
  const dummyKey = Buffer.alloc(32, 7).toString('base64')
  process.env.SHIPPING_MASTER_KEY = dummyKey
  process.env.SHIPPING_MOCK_MODE = 'true'
  t.after(() => {
    if (originalMasterKey === undefined) delete process.env.SHIPPING_MASTER_KEY
    else process.env.SHIPPING_MASTER_KEY = originalMasterKey
    if (originalMockMode === undefined) delete process.env.SHIPPING_MOCK_MODE
    else process.env.SHIPPING_MOCK_MODE = originalMockMode
  })

  resetShippingMock()
  const credentials = { apiId: 'ID-7', apiToken: 'TOK-9' }
  const aad = connectionAad({
    tenantId: TENANT_ID, storeId: STORE_ID, providerCode: 'yalidine', environment: 'sandbox',
  })
  const connectionRow = {
    id: CONNECTION_ID,
    tenant_id: TENANT_ID,
    store_id: STORE_ID,
    provider_code: 'yalidine',
    environment: 'sandbox',
    mode: 'api',
    enabled: true,
    credentials_ciphertext: encryptCredentials(credentials, aad, { SHIPPING_MASTER_KEY: dummyKey }),
    credentials_hint: '•••• TOK-9',
    origin_wilaya_code: '16',
    defaults: { deliveryType: 'home', autoShip: false, stopDeskId: '' },
    created_by: STAFF_ID,
    updated_by: STAFF_ID,
  }
  const snapshot = {
    id: ORDER_ID,
    order_number: 'ORD-1001',
    status: 'confirmed',
    fulfillment_type: 'delivery',
    customer_name: 'أحمد بن علي',
    customer_phone: '0555123456',
    wilaya_code: '25',
    commune: 'Centre Ville',
    address: 'شارع الأمير عبد القادر، قسنطينة',
    note: 'اتصال قبل التسليم',
    total: 5000,
    delivery_fee: 500,
    store_id: STORE_ID,
    tenant_id: TENANT_ID,
    created_at: '2026-11-13T09:00:00Z',
    items: [{ product_name: 'قميص', qty: 2, unit_price: 2000, size: 'L', color: 'أزرق', line_total: 4000 }],
  }
  const state = makeState(connectionRow, snapshot)
  const adminClient = new FakeAdmin(state)
  const userClient = makeUserClient(state)
  const ctx = {
    tenantId: TENANT_ID,
    staffId: STAFF_ID,
    role: 'owner',
    storeId: STORE_ID,
    stores: [{ id: STORE_ID }],
  }

  const created = await shipOrder({
    adminClient, userClient, ctx, storeId: STORE_ID,
    input: { orderId: ORDER_ID, providerCode: 'yalidine', environment: 'sandbox' },
  })
  assert.match(created.trackingNumber, /^YAL-MOCK-/)
  assert.equal(created.mode, 'mock')
  assert.equal(created.shipment.status, 'created')
  assert.equal(created.shipment.order_id, ORDER_ID)
  assert.equal(state.shipments.length, 1)
  assert.equal(state.events.length, 1)
  assert.deepEqual(state.rpcCalls.map(call => call.name), ['engine_order_shipping_snapshot'])

  advanceMockParcel(created.trackingNumber, 'En livraison', 'خرج للتسليم')
  const synced = await syncShipment({
    adminClient, ctx, storeId: STORE_ID, shipmentId: created.shipment.id,
  })
  assert.equal(synced.shipment.status, 'in_transit')
  assert.equal(synced.tracking.status, 'in_transit')
  assert.ok(state.events.length >= 3, 'tracking events are appended idempotently')

  const webhookSecret = 'unit-test-webhook-secret'
  const rawBody = JSON.stringify({
    events: [{ tracking: created.trackingNumber, status: 'Livré', at: '2026-11-13T14:00:00Z' }],
  })
  const signature = createHmac('sha256', webhookSecret).update(rawBody).digest('hex')
  const webhook = await handleShippingWebhook({
    adminClient,
    providerCode: 'yalidine',
    rawBody,
    headers: { 'X-Yalidine-Signature': signature },
    env: { SHIPPING_YALIDINE_WEBHOOK_SECRET: webhookSecret },
  })
  assert.equal(webhook.received, 1)
  assert.equal(webhook.updated, 1)
  assert.equal(webhook.secretUsed, 'configured')
  assert.equal(state.shipments[0].status, 'delivered')

  await assert.rejects(
    () => handleShippingWebhook({
      adminClient,
      providerCode: 'yalidine',
      rawBody,
      headers: { 'X-Yalidine-Signature': 'deadbeef' },
      env: { SHIPPING_YALIDINE_WEBHOOK_SECRET: webhookSecret },
    }),
    error => error.code === 'AUTH',
  )

  const cancelled = await cancelShipment({
    adminClient, ctx, storeId: STORE_ID, shipmentId: created.shipment.id,
  })
  assert.equal(cancelled.shipment.status, 'cancelled')
  assert.equal(getMockParcel(created.trackingNumber)?.last_status, 'Annulé')

  // Re-shipping after cancellation must not collide with the old idempotency
  // key. A different order number gives the mock a distinct parcel.
  state.snapshot.order_number = 'ORD-1001-R'
  const reshipped = await shipOrder({
    adminClient, userClient, ctx, storeId: STORE_ID,
    input: { orderId: ORDER_ID, providerCode: 'yalidine', environment: 'sandbox' },
  })
  assert.notEqual(reshipped.trackingNumber, created.trackingNumber)
  assert.equal(state.shipments.length, 2)
  assert.notEqual(state.shipments[0].idempotency_key, state.shipments[1].idempotency_key)

  assert.ok(!state.tablesUsed.has('orders'), 'public.orders must never be written by the gateway')
  assert.deepEqual([...state.tablesUsed].sort(), [
    'shipment_events', 'shipments', 'shipping_connections',
  ].sort())
})
