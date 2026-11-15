// SERVER-ONLY: complete Yalidine adapter (P3), written against a canonical
// contract so the UI and the gateway never contain `if (yalidine)`.
//
// Everything runs through lib/shipping/transport.js. With SHIPPING_MOCK_MODE=true
// it talks to mockFetch (offline, deterministic); with real Sandbox keys the
// same functions hit https://api.yalidine.app/v1/. Field names follow Yalidine's
// parcel API and must be re-confirmed against the official docs when keys arrive.

import { createHmac, timingSafeEqual } from 'node:crypto'
import { getProvider } from '../registry.js'
import { shippingRequest, shippingMode } from '../transport.js'
import { ShippingError } from '../contract.js'
import { yalidineWilayaName } from '../wilayaNames.js'
import { wilayaCodeOf } from '../../delivery.js'

const PROVIDER = getProvider('yalidine')

const STATUS_MAP = Object.freeze({
  'créé': 'created', 'cree': 'created', 'created': 'created', 'créer': 'created',
  'prêt': 'created', 'pret': 'created', 'en attente': 'created', 'pending': 'created',
  'en cours': 'in_transit', 'en transit': 'in_transit', 'expédié': 'in_transit',
  'expedie': 'in_transit', 'shipped': 'in_transit', 'in_transit': 'in_transit',
  'en livraison': 'in_transit', 'sorti pour livraison': 'in_transit',
  'livré': 'delivered', 'livree': 'delivered', 'livré au client': 'delivered',
  'delivered': 'delivered', 'تم التسليم': 'delivered',
  'retourné': 'returned', 'retournee': 'returned', 'retour': 'returned',
  'returned': 'returned', 'retourné à l\'expéditeur': 'returned',
  'annulé': 'cancelled', 'annulee': 'cancelled', 'annulée': 'cancelled',
  'cancelled': 'cancelled', 'canceled': 'cancelled', 'ملغى': 'cancelled',
})

const CANONICAL_SHIPMENT_STATUS = Object.freeze({
  created: 'created', in_transit: 'in_transit', delivered: 'delivered',
  returned: 'returned', cancelled: 'cancelled', unknown: null,
})

export function mapStatus(rawStatus) {
  const key = String(rawStatus ?? '').trim().toLowerCase()
  return STATUS_MAP[key] || 'unknown'
}

/** Canonical -> shipments.status (never 'unknown', which the CHECK rejects). */
export function shipmentStatusFrom(canonical, fallback = 'created') {
  return CANONICAL_SHIPMENT_STATUS[canonical] ?? fallback
}

export function authHeaders(credentials = {}) {
  return {
    'X-API-ID': String(credentials.apiId ?? ''),
    'X-API-TOKEN': String(credentials.apiToken ?? ''),
    Accept: 'application/json',
  }
}

function splitName(name) {
  const parts = String(name ?? '').trim().split(/\s+/).filter(Boolean)
  return { firstname: parts[0] || 'زبون', familyname: parts.slice(1).join(' ') || '—' }
}

function normalizePhone(phone) {
  const digits = String(phone ?? '').replace(/[^0-9+]/g, '')
  if (/^213[5-7][0-9]{8}$/.test(digits)) return `0${digits.slice(3)}`
  return digits || ''
}

/** Canonical ShipmentRequest -> Yalidine parcel payload. Pure, unit-testable. */
export function buildShipmentPayload(request = {}, connection = {}) {
  const { firstname, familyname } = splitName(request.customerName)
  const toCode = wilayaCodeOf(request.wilayaCode)
  const fromCode = wilayaCodeOf(
    connection.originWilayaCode || connection.origin_wilaya_code || request.originWilayaCode,
  )
  const codAmount = Math.max(0, Math.round(Number(request.codAmount) || 0))
  const deliveryFee = Math.max(0, Math.round(Number(request.deliveryFee) || 0))
  const items = Array.isArray(request.items) ? request.items : []
  const productList = String(request.productList || items.map(item => (
    `${item.product_name || item.name || ''}${item.qty ? ` ×${item.qty}` : ''}`
  )).filter(Boolean).join(' · ')).slice(0, 250)

  return {
    order_id: String(request.orderNumber || request.orderId || ''),
    firstname,
    familyname,
    contact_phone: normalizePhone(request.customerPhone),
    address: String(request.address || request.commune || '—').slice(0, 200),
    to_commune_name: String(request.commune || '').slice(0, 120),
    to_wilaya_name: yalidineWilayaName(toCode),
    from_wilaya_name: yalidineWilayaName(fromCode),
    product_list: productList || 'طلب فترينة',
    price: codAmount,
    delivery_fee: deliveryFee,
    freeshipping: deliveryFee === 0,
    is_stopdesk: request.deliveryType === 'stopdesk',
    stopdesk_id: request.deliveryType === 'stopdesk' ? String(request.stopDeskId || '') : null,
    has_exchange: false,
    do_insurance: false,
    declared_value: codAmount,
    weight: 1,
    length: 20,
    width: 15,
    height: 10,
    note: String(request.note || '').slice(0, 250),
  }
}

function context(options = {}) {
  return {
    environment: options.environment || 'sandbox',
    env: options.env || process.env,
    connection: options.connection || {},
    fetchImpl: options.fetchImpl || null,
  }
}

function requestInit(credentials, method, path, body = null) {
  return {
    provider: PROVIDER,
    path,
    method,
    body,
    headers: authHeaders(credentials),
  }
}

const YALIDINE_BULK_COLUMNS = Object.freeze([
  { label: 'رقم الطلب', key: 'order_id' },
  { label: 'الاسم', key: 'firstname' },
  { label: 'اللقب', key: 'familyname' },
  { label: 'رقم الهاتف', key: 'contact_phone' },
  { label: 'ولاية الوجهة', key: 'to_wilaya_name' },
  { label: 'ولاية الانطلاق', key: 'from_wilaya_name' },
  { label: 'البلدية', key: 'to_commune_name' },
  { label: 'العنوان', key: 'address' },
  { label: 'المبلغ عند الاستلام (دج)', key: 'price' },
  { label: 'رسوم التوصيل (دج)', key: 'delivery_fee' },
  { label: 'قائمة المنتجات', key: 'product_list' },
  { label: 'استلام من نقطة', key: 'is_stopdesk' },
  { label: 'معرّف النقطة', key: 'stopdesk_id' },
  { label: 'ملاحظة', key: 'note' },
])

/** P4: carrier-specific CSV columns, derived from the same parcel payload. */
function buildBulkRows({ requests = [], connection = {}, environment = 'sandbox' } = {}) {
  const rows = requests.map(request => {
    const payload = buildShipmentPayload(request, connection)
    return {
      order_id: payload.order_id,
      firstname: payload.firstname,
      familyname: payload.familyname,
      contact_phone: payload.contact_phone,
      to_wilaya_name: payload.to_wilaya_name,
      from_wilaya_name: payload.from_wilaya_name,
      to_commune_name: payload.to_commune_name,
      address: payload.address,
      price: payload.price,
      delivery_fee: payload.delivery_fee,
      product_list: payload.product_list,
      is_stopdesk: payload.is_stopdesk ? 'نعم' : 'لا',
      stopdesk_id: payload.stopdesk_id || '',
      note: payload.note,
    }
  })
  return {
    columns: YALIDINE_BULK_COLUMNS,
    rows,
    templateVersion: 'yalidine-v1',
    filePrefix: 'yalidine',
    environment,
  }
}

export const yalidineAdapter = Object.freeze({
  code: 'yalidine',
  label: PROVIDER.label,
  platform: PROVIDER.platform,
  capabilities: Object.freeze({
    create: true, track: true, label: true, cancel: true,
    webhook: true, pullStatuses: true, bulkTemplate: true, fees: false, test: true,
  }),

  mapStatus,
  shipmentStatusFrom,
  authHeaders,
  buildShipmentPayload,
  buildBulkRows,

  async testConnection(credentials, environment = 'sandbox', env = process.env) {
    const mode = shippingMode(env, PROVIDER, environment)
    const started = Date.now()
    try {
      const { data, status } = await shippingRequest({
        ...requestInit(credentials, 'GET', ''),
        environment, env,
      })
      return {
        ok: true, mode, reachable: true, code: 'OK', httpStatus: status,
        latencyMs: Date.now() - started,
        message: mode === 'mock'
          ? `تم الاتصال بمحاكي Yalidine بنجاح (HTTP ${status}) — بيانات وهمية.`
          : `الاتصال بـ Yalidine ناجح (HTTP ${status}).`,
        account: data && typeof data === 'object' ? { provider: data.provider || 'yalidine' } : null,
      }
    } catch (error) {
      return {
        ok: false, mode, reachable: false, httpStatus: null,
        code: error instanceof ShippingError ? error.code : 'PROVIDER_ERROR',
        message: error.message || 'تعذر اختبار الاتصال',
        latencyMs: Date.now() - started,
      }
    }
  },

  async createShipment(request = {}, credentials = {}, options = {}) {
    const { environment, env, connection, fetchImpl } = context(options)
    const payload = buildShipmentPayload(request, connection)
    if (!payload.order_id || !payload.to_wilaya_name) {
      throw new ShippingError('VALIDATION', 'رقم الطلب وولاية الوجهة مطلوبان للشحن', 400)
    }
    const { data, status, mode } = await shippingRequest({
      ...requestInit(credentials, 'POST', 'parcels', payload),
      environment, env, fetchImpl,
    })
    const tracking = data?.tracking || data?.tracking_number || data?.id || data?.data?.tracking
    if (!tracking) throw new ShippingError('PROVIDER_ERROR', 'لم يُرجع رقم تتبّع من شركة التوصيل', 502)
    return {
      trackingNumber: String(tracking),
      externalId: String(data?.id || tracking),
      labelUrl: String(data?.label || data?.label_url || ''),
      status: 'created',
      rawStatus: data?.last_status || 'Créé',
      httpStatus: status,
      mode,
      raw: data,
    }
  },

  async getTracking(tracking, credentials = {}, options = {}) {
    const { environment, env, fetchImpl } = context(options)
    if (!tracking) throw new ShippingError('VALIDATION', 'رقم التتبّع مطلوب', 400)
    const { data, status, mode } = await shippingRequest({
      ...requestInit(credentials, 'GET', `parcels/${encodeURIComponent(String(tracking))}`),
      environment, env, fetchImpl,
    })
    const rawStatus = data?.last_status || data?.status || data?.data?.last_status || ''
    const canonical = mapStatus(rawStatus)
    const history = Array.isArray(data?.history) ? data.history : []
    const events = history.map((event, index) => {
      const eventRaw = String(event?.status ?? event?.last_status ?? rawStatus)
      const at = String(event?.at || event?.date || event?.occurred_at || '')
      return {
        eventKey: `yalidine:${tracking}:${eventRaw}:${at || index}`,
        trackingNumber: String(tracking),
        rawStatus: eventRaw,
        canonicalStatus: mapStatus(eventRaw),
        occurredAt: at || null,
        label: String(event?.label || ''),
      }
    })
    return {
      trackingNumber: String(tracking),
      status: canonical,
      rawStatus: String(rawStatus),
      events,
      httpStatus: status,
      mode,
      raw: data,
    }
  },

  async getLabel(tracking, credentials = {}, options = {}) {
    const { environment, env, fetchImpl } = context(options)
    if (!tracking) throw new ShippingError('VALIDATION', 'رقم التتبّع مطلوب', 400)
    const { data, mode } = await shippingRequest({
      ...requestInit(credentials, 'GET', `parcels/${encodeURIComponent(String(tracking))}/label`),
      environment, env, fetchImpl,
    })
    const labelUrl = String(data?.url || data?.label || data?.label_url || '')
    if (!labelUrl) throw new ShippingError('NOT_FOUND', 'لا يوجد ملصق لهذا الطرد', 404)
    return { trackingNumber: String(tracking), labelUrl, mode }
  },

  async cancelShipment(tracking, credentials = {}, options = {}) {
    const { environment, env, fetchImpl } = context(options)
    if (!tracking) throw new ShippingError('VALIDATION', 'رقم التتبّع مطلوب', 400)
    await shippingRequest({
      ...requestInit(credentials, 'DELETE', `parcels/${encodeURIComponent(String(tracking))}`),
      environment, env, fetchImpl,
    })
    return { ok: true, trackingNumber: String(tracking), status: 'cancelled' }
  },

  async pullStatuses(credentials = {}, options = {}) {
    const { environment, env, fetchImpl } = context(options)
    const { data, mode } = await shippingRequest({
      ...requestInit(credentials, 'GET', 'parcels'),
      environment, env, fetchImpl,
    })
    const rows = Array.isArray(data?.data) ? data.data : []
    return {
      mode,
      parcels: rows.map(row => ({
        trackingNumber: String(row.tracking || row.tracking_number || ''),
        rawStatus: String(row.last_status || row.status || ''),
        status: mapStatus(row.last_status || row.status),
      })),
    }
  },

  async syncTerritories(credentials = {}, options = {}) {
    const { environment, env, fetchImpl } = context(options)
    const { data, mode } = await shippingRequest({
      ...requestInit(credentials, 'GET', 'wilayas'),
      environment, env, fetchImpl,
    })
    const rows = Array.isArray(data?.data) ? data.data : []
    return {
      mode,
      territories: rows.map(row => ({
        wilayaCode: String(row.code ?? row.id ?? '').padStart(2, '0'),
        communeName: '',
        externalId: String(row.id ?? row.code ?? ''),
        name: String(row.name || ''),
      })),
    }
  },

  /** HMAC-SHA256 over the EXACT raw body (never a re-serialised object). */
  verifyWebhook(rawBody, headers = {}, secret = '') {
    if (!secret) return false
    const lookup = name => {
      if (typeof headers?.get === 'function') return headers.get(name) || ''
      const key = Object.keys(headers || {}).find(entry => entry.toLowerCase() === name.toLowerCase())
      return key ? String(headers[key] ?? '') : ''
    }
    const provided = lookup('X-Yalidine-Signature').replace(/^sha256=/i, '').trim()
    if (!provided) return false
    const expected = createHmac('sha256', String(secret)).update(String(rawBody)).digest('hex')
    const left = Buffer.from(provided, 'utf8')
    const right = Buffer.from(expected, 'utf8')
    return left.length === right.length && timingSafeEqual(left, right)
  },

  parseWebhook(payload) {
    const rows = Array.isArray(payload) ? payload
      : Array.isArray(payload?.events) ? payload.events
        : Array.isArray(payload?.data) ? payload.data : []
    return rows.map(row => {
      const tracking = String(row.tracking || row.tracking_number || row.id || '')
      const rawStatus = String(row.status || row.last_status || '')
      const at = String(row.at || row.occurred_at || row.date || '')
      return {
        trackingNumber: tracking,
        rawStatus,
        canonicalStatus: mapStatus(rawStatus),
        occurredAt: at || null,
        eventKey: `yalidine:${tracking}:${rawStatus}:${at || row.event_id || ''}`,
      }
    }).filter(event => event.trackingNumber)
  },
})
