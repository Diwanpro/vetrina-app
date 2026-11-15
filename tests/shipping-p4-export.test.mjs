import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { createShippingExport } from '../lib/shipping/export.js'

const TENANT_ID = '11111111-1111-4111-8111-111111111111'
const STORE_ID = '22222222-2222-4222-8222-222222222222'
const STAFF_ID = '44444444-4444-4444-8444-444444444444'

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
    return {
      shipping_connections: this.state.connections,
      shipments: this.state.shipments,
      shipping_export_batches: this.state.batches,
      shipping_export_items: this.state.exportItems,
    }[this.table] || []
  }

  select() { return this }
  delete() { this.action = 'delete'; return this }
  insert(payload) {
    this.action = 'insert'
    this.payload = payload
    return this
  }
  eq(key, value) { this.filters.push([key, value]); return this }
  matches(row) { return this.filters.every(([key, value]) => row[key] === value) }

  applyInsert() {
    if (this.applied) return
    this.applied = true
    const rows = Array.isArray(this.payload) ? this.payload : [this.payload]
    const now = new Date().toISOString()

    if (this.table === 'shipping_export_batches') {
      const row = { id: randomUUID(), created_at: now, ...this.payload }
      this.state.batches.push(row)
      this.result = row
      return
    }

    if (this.table === 'shipments') {
      const duplicateActive = !this.state.skipShipmentGuard && rows.some(row => (
        this.state.shipments.some(existing => (
          existing.order_id === row.order_id &&
          existing.provider_code === row.provider_code &&
          !['cancelled', 'failed'].includes(existing.status)
        ))
      ))
      const duplicateKey = rows.some(row => (
        this.state.shipments.some(existing => existing.idempotency_key === row.idempotency_key)
      ))
      if (duplicateActive || duplicateKey) {
        this.insertError = { code: '23505', message: 'duplicate active shipment' }
        this.result = null
        return
      }
      const inserted = rows.map(row => ({ id: randomUUID(), created_at: now, ...row }))
      this.state.shipments.push(...inserted)
      this.result = inserted
      return
    }

    if (this.table === 'shipping_export_items') {
      const duplicate = rows.some(row => (
        this.state.exportItems.some(existing => (
          existing.tenant_id === row.tenant_id && existing.order_id === row.order_id
        ))
      ))
      if (duplicate) {
        this.insertError = { code: '23505', message: 'duplicate export item' }
        this.result = null
        return
      }
      const inserted = rows.map(row => ({ id: randomUUID(), created_at: now, ...row }))
      this.state.exportItems.push(...inserted)
      this.result = inserted
      return
    }

    this.insertError = { code: '23505', message: `unexpected insert into ${this.table}` }
    this.result = null
  }

  applyDelete() {
    if (this.applied) return
    this.applied = true
    const rows = this.rows()
    for (let index = rows.length - 1; index >= 0; index -= 1) {
      if (this.matches(rows[index])) rows.splice(index, 1)
    }
    this.result = []
  }

  async maybeSingle() {
    return { data: this.rows().find(row => this.matches(row)) || null, error: null }
  }

  async single() {
    if (this.action === 'insert') this.applyInsert()
    return { data: this.result, error: this.insertError }
  }

  // Supabase query builders are thenable: `await query.insert(rows).select(...)`
  // and `await query.delete().eq(...)` both resolve through this method.
  then(resolve, reject) {
    try {
      if (this.action === 'insert') this.applyInsert()
      else if (this.action === 'delete') this.applyDelete()
      resolve({
        data: this.result ?? this.rows().filter(row => this.matches(row)),
        error: this.insertError,
      })
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

function snapshot(id, orderNumber, status, overrides = {}) {
  return {
    id,
    order_number: orderNumber,
    status,
    fulfillment_type: 'delivery',
    customer_name: 'أحمد بن علي',
    customer_phone: '0555 12 34 56',
    wilaya_code: '25',
    commune: 'Centre Ville',
    address: 'شارع الأمير عبد القادر، قسنطينة',
    note: 'اتصال قبل التسليم',
    total: 5000,
    delivery_fee: 500,
    store_id: STORE_ID,
    tenant_id: TENANT_ID,
    created_at: '2026-11-13T09:00:00Z',
    items: [{ product_name: 'قميص', qty: 2, unit_price: 2000, color: 'أزرق', size: 'L', line_total: 4000 }],
    ...overrides,
  }
}

function makeState({ providerCode = 'yalidine', mode = 'bulk' } = {}) {
  const orders = [
    snapshot('a1111111-1111-4111-8111-111111111111', 'ORD-1001', 'confirmed', {
      note: '=SUM(1+1)',
    }),
    snapshot('a2222222-2222-4222-8222-222222222222', 'ORD-1002', 'preparing', {
      customer_name: 'فاطمة الزهراء', customer_phone: '0666123456',
    }),
    snapshot('a3333333-3333-4333-8333-333333333333', 'ORD-1003', 'new'),
    snapshot('a4444444-4444-4444-8444-444444444444', 'ORD-1004', 'delivered'),
    snapshot('a5555555-5555-4555-8555-555555555555', 'ORD-1005', 'confirmed', {
      fulfillment_type: 'pickup',
    }),
    snapshot('a6666666-6666-4666-8666-666666666666', 'ORD-1006', 'confirmed'),
  ]
  return {
    connections: [{
      id: 'b1111111-1111-4111-8111-111111111111',
      tenant_id: TENANT_ID,
      store_id: STORE_ID,
      provider_code: providerCode,
      environment: 'sandbox',
      mode,
      enabled: true,
      credentials_ciphertext: null,
      credentials_hint: '',
      origin_wilaya_code: '16',
      defaults: { deliveryType: 'home', autoShip: false, stopDeskId: '' },
    }],
    orders,
    // A pre-existing active shipment excludes ORD-1006 from candidates.
    shipments: [{
      id: 'c1111111-1111-4111-8111-111111111111',
      tenant_id: TENANT_ID,
      store_id: STORE_ID,
      order_id: 'a6666666-6666-4666-8666-666666666666',
      provider_code: providerCode,
      environment: 'sandbox',
      mode: 'api',
      external_id: 'YAL-MOCK-EXISTING',
      status: 'created',
      raw_status: 'Créé',
      idempotency_key: 'already-shipped-key',
    }],
    batches: [],
    exportItems: [],
    tablesUsed: new Set(),
    rpcCalls: [],
    rpcError: null,
    rpcIgnoresExports: false,
    skipShipmentGuard: false,
  }
}

function makeUserClient(state) {
  return {
    rpc: async (name, args) => {
      state.rpcCalls.push({ name, args })
      if (state.rpcError) return { data: null, error: state.rpcError }
      if (name !== 'engine_shipping_export_candidates') return { data: null, error: null }
      const eligible = state.orders.filter(order => {
        if (order.store_id !== args.p_store) return false
        if (order.fulfillment_type !== 'delivery') return false
        if (!['confirmed', 'preparing'].includes(order.status)) return false
        if (state.rpcIgnoresExports) return true
        if (state.exportItems.some(item => item.order_id === order.id)) return false
        if (state.shipments.some(shipment => (
          shipment.order_id === order.id && !['cancelled', 'failed'].includes(shipment.status)
        ))) return false
        return true
      })
      return { data: eligible, error: null }
    },
  }
}

function ctx() {
  return {
    tenantId: TENANT_ID,
    staffId: STAFF_ID,
    role: 'owner',
    storeId: STORE_ID,
    stores: [{ id: STORE_ID }],
  }
}

async function exportWith(state, providerCode = 'yalidine', environment = 'sandbox') {
  return createShippingExport({
    adminClient: new FakeAdmin(state),
    userClient: makeUserClient(state),
    ctx: ctx(),
    storeId: STORE_ID,
    input: { providerCode, environment },
  })
}

test('P4 export writes a BOM CSV for only confirmed/preparing delivery orders', async () => {
  const state = makeState({ providerCode: 'yalidine', mode: 'bulk' })
  const result = await exportWith(state, 'yalidine')

  assert.equal(result.providerCode, 'yalidine')
  assert.equal(result.rowCount, 2)
  assert.equal(result.environment, 'sandbox')
  assert.equal(result.templateVersion, 'yalidine-v1')
  assert.match(result.filename, /^shipping-yalidine-sandbox-\d{4}-\d{2}-\d{2}\.csv$/)
  assert.equal(result.fileHash, createHash('sha256').update(result.csv).digest('hex'))
  assert.equal(result.csv.charCodeAt(0), 0xFEFF)
  assert.match(result.csv, /"رقم الطلب"/)
  assert.match(result.csv, /"ORD-1001"/)
  assert.match(result.csv, /"ORD-1002"/)
  assert.doesNotMatch(result.csv, /"ORD-1003"|"ORD-1004"|"ORD-1005"|"ORD-1006"/)
  assert.match(result.csv, /"'=SUM\(1\+1\)"/, 'csvText neutralises formula injection')
  assert.ok(result.csv.includes('\r\n'))

  assert.deepEqual(state.rpcCalls.map(call => call.name), ['engine_shipping_export_candidates'])
  assert.equal(state.rpcCalls[0].args.p_store, STORE_ID)
  assert.equal(state.rpcCalls[0].args.p_provider_code, 'yalidine')
  assert.equal(state.batches.length, 1)
  assert.equal(state.batches[0].provider_code, 'yalidine')
  assert.equal(state.batches[0].row_count, 2)
  assert.equal(state.batches[0].file_hash, result.fileHash)
  assert.deepEqual(state.batches[0].filters.statuses, ['confirmed', 'preparing'])
  assert.equal(state.batches[0].filters.excludeShipped, true)
  assert.equal(state.batches[0].filters.excludeExported, true)
  assert.equal(state.exportItems.length, 2)
  assert.ok(state.exportItems.every(item => item.shipment_id))
  assert.equal(state.shipments.filter(row => row.mode === 'bulk').length, 2)
  assert.ok(state.shipments.filter(row => row.mode === 'bulk').every(row => row.status === 'exported'))
  assert.ok(!state.tablesUsed.has('orders'), 'public.orders must never be written by the export gateway')
  assert.deepEqual([...state.tablesUsed].sort(), [
    'shipping_connections', 'shipping_export_batches', 'shipping_export_items', 'shipments',
  ].sort())
})

test('the second export finds no eligible orders; a stale replay hits the unique guard', async () => {
  const state = makeState({ providerCode: 'yalidine', mode: 'both' })
  await exportWith(state, 'yalidine')

  await assert.rejects(
    () => exportWith(state, 'yalidine'),
    error => error.name === 'ShippingError' && error.code === 'NOT_FOUND',
  )
  assert.equal(state.batches.length, 1)
  assert.equal(state.exportItems.length, 2)

  // Simulate a stale RPC snapshot + a missing partial shipment index. The
  // unique (tenant_id, order_id) export-item guard still blocks the duplicate.
  state.rpcIgnoresExports = true
  state.skipShipmentGuard = true
  await assert.rejects(
    () => exportWith(state, 'yalidine'),
    error => error.name === 'ShippingError' && error.code === 'CONFLICT',
  )
  assert.equal(state.batches.length, 1, 'failed batch is rolled back')
  assert.equal(state.exportItems.length, 2)
  assert.equal(state.shipments.filter(row => row.mode === 'bulk').length, 2)
  assert.ok(!state.tablesUsed.has('orders'))
})

test('API-only connections cannot export, but all three bulk/both templates can', async () => {
  const apiOnly = makeState({ providerCode: 'yalidine', mode: 'api' })
  await assert.rejects(
    () => exportWith(apiOnly, 'yalidine'),
    error => error.name === 'ShippingError' && error.code === 'VALIDATION',
  )
  assert.equal(apiOnly.batches.length, 0)
  assert.equal(apiOnly.rpcCalls.length, 0)

  const expectedPrefix = {
    yalidine: 'yalidine',
    zrexpress: 'zrexpress-procolis',
    zrexpressnew: 'zrexpress-new',
  }
  for (const providerCode of ['yalidine', 'zrexpress', 'zrexpressnew']) {
    const state = makeState({ providerCode, mode: 'both' })
    const result = await exportWith(state, providerCode)
    assert.equal(result.providerCode, providerCode)
    assert.equal(result.rowCount, 2)
    assert.equal(state.batches[0].filters.providerCode, providerCode)
    assert.equal(state.batches[0].row_count, 2)
    assert.equal(state.exportItems.length, 2)
    assert.equal(state.shipments.filter(row => row.mode === 'bulk').length, 2)
    assert.equal(result.csv.charCodeAt(0), 0xFEFF)
    assert.match(result.csv, /"رقم الطلب"/)
    assert.match(result.csv, /"'=SUM\(1\+1\)"/)
    assert.match(result.filename, new RegExp(`^shipping-${expectedPrefix[providerCode]}-sandbox-\\d{4}-\\d{2}-\\d{2}\\.csv$`))
    assert.ok(!state.tablesUsed.has('orders'))
  }
})
