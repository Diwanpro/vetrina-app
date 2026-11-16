// SERVER-ONLY shared ZR adapter skeleton (P4).
//
// Yalidine, ZR Express/Procolis and ZR Express new-platform all expose the SAME
// adapter contract, so the gateway, OrderCard and CSV export never branch on a
// courier name. The two ZR files in this folder supply only their own auth,
// payload, territory endpoint and CSV columns; everything below is the common
// lifecycle: create/track/label/cancel/pull/status mapping/webhook/export.

import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import { getProvider } from '../registry.js'
import { shippingRequest, shippingMode } from '../transport.js'
import { ShippingError } from '../contract.js'
import { WILAYAS } from '../../wilayas.js'
import { wilayaCodeOf } from '../../delivery.js'

const STATUS_MAP = Object.freeze({
  'créé': 'created', 'cree': 'created', 'created': 'created',
  'en attente': 'created', 'pending': 'created', 'prêt': 'created', 'pret': 'created',
  'en cours': 'in_transit', 'en transit': 'in_transit', 'expédié': 'in_transit',
  'expedie': 'in_transit', 'shipped': 'in_transit', 'in_transit': 'in_transit',
  'en livraison': 'in_transit', 'out for delivery': 'in_transit',
  'livré': 'delivered', 'livree': 'delivered', 'delivered': 'delivered', 'تم التسليم': 'delivered',
  'retourné': 'returned', 'retournee': 'returned', 'returned': 'returned',
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

export function shipmentStatusFrom(canonical, fallback = 'created') {
  return CANONICAL_SHIPMENT_STATUS[canonical] ?? fallback
}

export function normalizePhone(phone) {
  const digits = String(phone ?? '').replace(/[^0-9+]/g, '')
  if (/^213[5-7][0-9]{8}$/.test(digits)) return `0${digits.slice(3)}`
  return digits || ''
}

export function wilayaName(code) {
  return WILAYAS.find(entry => entry.code === code)?.name || ''
}

export function productListFrom(request) {
  const items = Array.isArray(request.items) ? request.items : []
  return String(request.productList || items.map(item => (
    `${item.product_name || item.name || ''}${item.qty ? ` ×${item.qty}` : ''}`
  )).filter(Boolean).join(' · ')).slice(0, 250) || 'طلب فترينة'
}

/** Deterministic UUID-shaped territory id for the ZR new-platform template. */
export function deterministicTerritoryId(wilayaCode, commune) {
  const hex = createHash('sha256')
    .update(`zrnew:territory:${wilayaCode}:${commune || 'Centre Ville'}`)
    .digest('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`
}

export function procolisAuthHeaders(credentials = {}) {
  return {
    Authorization: `Token ${String(credentials.token ?? '').trim()}`,
    'X-Api-Key': String(credentials.key ?? '').trim(),
    Accept: 'application/json',
  }
}

export function newPlatformAuthHeaders(credentials = {}) {
  return {
    'X-Api-Key': String(credentials.apiKey ?? '').trim(),
    'X-Tenant': String(credentials.tenantId ?? '').trim(),
    Accept: 'application/json',
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

function requestInit(config, credentials, method, path, body = null) {
  return {
    provider: getProvider(config.code),
    path,
    method,
    body,
    headers: config.authHeaders(credentials),
  }
}

function lookupHeader(headers, name) {
  if (typeof headers?.get === 'function') return headers.get(name) || ''
  const key = Object.keys(headers || {}).find(entry => entry.toLowerCase() === name.toLowerCase())
  return key ? String(headers[key] ?? '') : ''
}

/**
 * Builds a complete ZR adapter from a small courier-specific config. Adding a
 * third ZR-like carrier later is one config file, not a gateway/UI change.
 */
export function createZrAdapter(config) {
  const provider = getProvider(config.code)
  const capabilities = Object.freeze({
    create: true, track: true, label: true, cancel: true,
    webhook: true, pullStatuses: true, bulkTemplate: true, fees: false, test: true,
  })

  function authHeaders(credentials = {}) {
    return config.authHeaders(credentials)
  }

  function buildShipmentPayload(request = {}, connection = {}) {
    const toCode = wilayaCodeOf(request.wilayaCode)
    const fromCode = wilayaCodeOf(
      connection.originWilayaCode || connection.origin_wilaya_code || request.originWilayaCode,
    )
    return config.buildPayload({
      request,
      connection,
      toCode,
      fromCode,
      toWilayaName: wilayaName(toCode),
      fromWilayaName: wilayaName(fromCode),
      codAmount: Math.max(0, Math.round(Number(request.codAmount) || 0)),
      deliveryFee: Math.max(0, Math.round(Number(request.deliveryFee) || 0)),
      productList: productListFrom(request),
      phone: normalizePhone(request.customerPhone),
      deliveryType: request.deliveryType === 'stopdesk' ? 'stopdesk' : 'home',
    })
  }

  function buildBulkRows({ requests = [], connection = {}, environment = 'sandbox' } = {}) {
    return {
      columns: config.bulkColumns,
      rows: requests.map(request => config.bulkRow(buildShipmentPayload(request, connection))),
      templateVersion: config.templateVersion,
      filePrefix: config.filePrefix,
      environment,
    }
  }

  return Object.freeze({
    code: config.code,
    label: config.label,
    platform: config.platform,
    capabilities,
    mapStatus,
    shipmentStatusFrom,
    authHeaders,
    buildShipmentPayload,
    buildBulkRows,

    async testConnection(credentials = {}, environment = 'sandbox', env = process.env, options = {}) {
      const mode = shippingMode(env, provider, environment)
      const started = Date.now()
      try {
        const { data, status } = await shippingRequest({
          ...requestInit(config, credentials, 'GET', ''),
          environment, env, fetchImpl: options.fetchImpl || null,
        })
        return {
          ok: true, mode, reachable: true, code: 'OK', httpStatus: status,
          latencyMs: Date.now() - started,
          message: mode === 'mock'
            ? `تم الاتصال بمحاكي ${config.label} بنجاح (HTTP ${status}) — بيانات وهمية.`
            : `الاتصال بـ ${config.label} ناجح (HTTP ${status}).`,
          account: data && typeof data === 'object' ? { provider: data.provider || config.code } : null,
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
      if (!String(payload[config.orderField] || '').trim() || !String(payload.phone || '').trim()) {
        throw new ShippingError('VALIDATION', 'رقم الطلب وهاتف الزبون مطلوبان للشحن', 400)
      }
      const { data, status, mode } = await shippingRequest({
        ...requestInit(config, credentials, 'POST', 'parcels', payload),
        environment, env, fetchImpl,
      })
      const tracking = data?.tracking || data?.tracking_number || data?.external_id || data?.id || data?.data?.tracking
      if (!tracking) throw new ShippingError('PROVIDER_ERROR', 'لم يُرجع رقم تتبّع من شركة التوصيل', 502)
      return {
        trackingNumber: String(tracking),
        externalId: String(data?.external_id || data?.id || tracking),
        labelUrl: String(data?.label || data?.label_url || ''),
        status: 'created',
        rawStatus: String(data?.last_status || data?.status || config.initialRawStatus),
        httpStatus: status,
        mode,
        raw: data,
      }
    },

    async getTracking(tracking, credentials = {}, options = {}) {
      const { environment, env, fetchImpl } = context(options)
      if (!tracking) throw new ShippingError('VALIDATION', 'رقم التتبّع مطلوب', 400)
      const { data, status, mode } = await shippingRequest({
        ...requestInit(config, credentials, 'GET', `parcels/${encodeURIComponent(String(tracking))}`),
        environment, env, fetchImpl,
      })
      const rawStatus = String(data?.last_status || data?.status || data?.data?.last_status || '')
      const history = Array.isArray(data?.history) ? data.history : []
      const events = history.map((event, index) => {
        const eventRaw = String(event?.status ?? event?.last_status ?? rawStatus)
        const at = String(event?.at || event?.date || event?.occurred_at || '')
        return {
          eventKey: `${config.code}:${tracking}:${eventRaw}:${at || index}`,
          trackingNumber: String(tracking),
          rawStatus: eventRaw,
          canonicalStatus: mapStatus(eventRaw),
          occurredAt: at || null,
          label: String(event?.label || ''),
        }
      })
      return {
        trackingNumber: String(tracking),
        status: mapStatus(rawStatus),
        rawStatus,
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
        ...requestInit(config, credentials, 'GET', `parcels/${encodeURIComponent(String(tracking))}/label`),
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
        ...requestInit(config, credentials, 'DELETE', `parcels/${encodeURIComponent(String(tracking))}`),
        environment, env, fetchImpl,
      })
      return { ok: true, trackingNumber: String(tracking), status: 'cancelled' }
    },

    async pullStatuses(credentials = {}, options = {}) {
      const { environment, env, fetchImpl } = context(options)
      const { data, mode } = await shippingRequest({
        ...requestInit(config, credentials, 'GET', 'parcels'),
        environment, env, fetchImpl,
      })
      const rows = Array.isArray(data?.data) ? data.data : []
      return {
        mode,
        parcels: rows.map(row => ({
          trackingNumber: String(row.tracking || row.tracking_number || row.external_id || row.id || ''),
          rawStatus: String(row.last_status || row.status || ''),
          status: mapStatus(row.last_status || row.status),
        })),
      }
    },

    async syncTerritories(credentials = {}, options = {}) {
      const { environment, env, fetchImpl } = context(options)
      const { data, mode } = await shippingRequest({
        ...requestInit(config, credentials, 'GET', config.territoryPath),
        environment, env, fetchImpl,
      })
      const rows = Array.isArray(data?.data) ? data.data : []
      return {
        mode,
        territories: rows.map(row => ({
          wilayaCode: String(row.code ?? row.wilaya_code ?? row.id ?? '').padStart(2, '0'),
          communeName: String(row.commune_name || ''),
          externalId: String(row.id ?? row.code ?? ''),
          name: String(row.name || ''),
        })),
      }
    },

    /** HMAC-SHA256 over the EXACT raw body, with ZR-specific signature headers. */
    verifyWebhook(rawBody, headers = {}, secret = '') {
      if (!secret) return false
      let provided = ''
      for (const name of config.signatureHeaders) {
        provided = lookupHeader(headers, name)
        if (provided) break
      }
      provided = provided.replace(/^sha256=/i, '').trim()
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
          eventKey: `${config.code}:${tracking}:${rawStatus}:${at || row.event_id || ''}`,
        }
      }).filter(event => event.trackingNumber)
    },
  })
}
