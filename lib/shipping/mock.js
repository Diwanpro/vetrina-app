// In-memory courier-shaped APIs used until real Sandbox keys are connected.
//
// Mock Fetch is a real `fetch`-compatible function: it returns a standard
// Response and never touches the network. It keeps parcel state between calls,
// so createShipment -> getTracking -> getLabel behaves like each courier would.
// Switching to the live API is one environment variable (SHIPPING_MOCK_MODE),
// not a code change. P4 adds ZR Express/Procolis and ZR Express new-platform
// endpoints alongside Yalidine, each with its own credentials and mock origin.

import { createHash } from 'node:crypto'
import { WILAYAS } from '../wilayas.js'

export const MOCK_BASE_URLS = Object.freeze({
  yalidine: 'https://mock.yalidine.local/v1/',
  zrexpress: 'https://mock.zrexpress.local/v1/',
  zrexpressnew: 'https://mock.zrexpressnew.local/v1/',
})
export const MOCK_BASE_URL = MOCK_BASE_URLS.yalidine

const HOST_TO_PROVIDER = Object.freeze(Object.fromEntries(
  Object.entries(MOCK_BASE_URLS).map(([code, url]) => [new URL(url).hostname, code]),
))

const parcels = new Map()
let sequence = 1000

/** Deterministic short hash so the same order always maps to the same parcel. */
function hash(value) {
  let result = 2166136261
  for (const char of String(value)) {
    result ^= char.charCodeAt(0)
    result = Math.imul(result, 16777619)
  }
  return (result >>> 0).toString(36).toUpperCase().padStart(7, '0').slice(0, 7)
}

/** Stable UUID-shaped territory/parcel id for the ZR new platform mock. */
function deterministicUuid(value) {
  const hex = createHash('sha256').update(String(value)).digest('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  })
}

function header(init, name) {
  const source = init?.headers || {}
  if (typeof source.get === 'function') return source.get(name) || ''
  const key = Object.keys(source).find(entry => entry.toLowerCase() === name.toLowerCase())
  return key ? String(source[key] ?? '') : ''
}

function bodyOf(init) {
  const raw = init?.body
  if (!raw) return {}
  if (typeof raw !== 'string') return raw
  try { return JSON.parse(raw) } catch { return {} }
}

function labelDataUrl(parcel) {
  const escape = value => String(value ?? '').replace(/[<>&"']/g, char => (
    { '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[char]
  ))
  const providerLabel = {
    yalidine: 'Yalidine', zrexpress: 'ZR Express / Procolis', zrexpressnew: 'ZR Express (new)',
  }[parcel.provider] || parcel.provider
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="420" height="260" viewBox="0 0 420 260">
<rect width="420" height="260" fill="#121212"/><rect x="10" y="10" width="400" height="240" fill="none" stroke="#D4AF37" stroke-width="2"/>
<text x="24" y="48" fill="#D4AF37" font-family="sans-serif" font-size="22">VETRINA · ${escape(providerLabel)} (MOCK)</text>
<text x="24" y="92" fill="#ffffff" font-family="sans-serif" font-size="18">Tracking: ${escape(parcel.tracking)}</text>
<text x="24" y="124" fill="#ffffff" font-family="sans-serif" font-size="16">Order: ${escape(parcel.order_id)}</text>
<text x="24" y="156" fill="#ffffff" font-family="sans-serif" font-size="16">To: ${escape(parcel.customer_name)}</text>
<text x="24" y="188" fill="#ffffff" font-family="sans-serif" font-size="16">COD: ${escape(parcel.price)} DZD</text>
<text x="24" y="228" fill="#888888" font-family="sans-serif" font-size="12">بورْدورو تجريبي — وضع المحاكاة</text>
</svg>`
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
}

function statusOf(parcel) {
  return {
    tracking: parcel.tracking,
    id: parcel.external_id,
    external_id: parcel.external_id,
    provider: parcel.provider,
    order_id: parcel.order_id,
    customer_name: parcel.customer_name,
    contact_phone: parcel.contact_phone,
    address: parcel.address,
    commune: parcel.commune,
    wilaya: parcel.wilaya,
    product_list: parcel.product_list,
    price: parcel.price,
    delivery_fee: parcel.delivery_fee,
    note: parcel.note,
    last_status: parcel.last_status,
    status: parcel.last_status,
    label: parcel.label,
    created_at: parcel.created_at,
    history: parcel.history,
  }
}

const PROVIDER_CONFIG = Object.freeze({
  yalidine: {
    prefix: 'YAL-MOCK',
    initialStatus: 'Créé', initialLabel: 'تم إنشاء الطرد',
    cancelStatus: 'Annulé', cancelLabel: 'تم إلغاء الطرد',
    territoryPath: 'wilayas',
    auth(init) {
      const apiId = header(init, 'X-API-ID')
      const token = header(init, 'X-API-TOKEN')
      return {
        ok: Boolean(apiId && token && apiId !== 'invalid' && token !== 'invalid'),
        values: [apiId, token],
      }
    },
    required: body => Boolean(body.firstname && body.contact_phone && body.order_id),
    orderId: body => String(body.order_id || ''),
    customer: body => `${body.firstname || ''} ${body.familyname || ''}`.trim(),
    phone: body => String(body.contact_phone || ''),
    address: body => String(body.address || ''),
    commune: body => String(body.to_commune_name || ''),
    wilaya: body => String(body.to_wilaya_name || ''),
    price: body => Number(body.price) || 0,
    deliveryFee: body => Number(body.delivery_fee) || 0,
    productList: body => String(body.product_list || ''),
    note: body => String(body.note || ''),
  },
  zrexpress: {
    prefix: 'ZR-MOCK',
    initialStatus: 'En attente', initialLabel: 'في انتظار الاستلام',
    cancelStatus: 'Annulé', cancelLabel: 'تم إلغاء الطرد',
    territoryPath: 'wilayas',
    auth(init) {
      const authorization = header(init, 'Authorization')
      const token = authorization.replace(/^Token\s+/i, '').trim()
      const key = header(init, 'X-Api-Key')
      return {
        ok: Boolean(token && key && token !== 'invalid' && key !== 'invalid'),
        values: [token, key],
      }
    },
    required: body => Boolean(body.order_id && body.client && body.phone),
    orderId: body => String(body.order_id || ''),
    customer: body => String(body.client || ''),
    phone: body => String(body.phone || ''),
    address: body => String(body.address || ''),
    commune: body => String(body.commune || ''),
    wilaya: body => String(body.wilaya_name || ''),
    price: body => Number(body.cod_amount) || 0,
    deliveryFee: body => Number(body.delivery_fee) || 0,
    productList: body => String(body.product_list || ''),
    note: body => String(body.note || ''),
  },
  zrexpressnew: {
    prefix: 'ZRN-MOCK',
    initialStatus: 'pending', initialLabel: 'تم إنشاء الطرد',
    cancelStatus: 'cancelled', cancelLabel: 'تم إلغاء الطرد',
    territoryPath: 'territories',
    auth(init) {
      const apiKey = header(init, 'X-Api-Key')
      const tenant = header(init, 'X-Tenant')
      return {
        ok: Boolean(apiKey && tenant && apiKey !== 'invalid' && tenant !== 'invalid'),
        values: [apiKey, tenant],
      }
    },
    required: body => Boolean(body.orderId && body.recipient && body.phone),
    orderId: body => String(body.orderId || ''),
    customer: body => String(body.recipient || ''),
    phone: body => String(body.phone || ''),
    address: body => String(body.address || ''),
    commune: body => String(body.commune || ''),
    wilaya: body => String(body.wilaya || ''),
    price: body => Number(body.codAmount) || 0,
    deliveryFee: body => Number(body.deliveryFee) || 0,
    productList: body => String(body.productList || ''),
    note: body => String(body.note || ''),
  },
})

function territoriesResponse(providerCode) {
  const data = WILAYAS.map(wilaya => providerCode === 'zrexpressnew'
    ? {
      id: deterministicUuid(`zrnew:territory:${wilaya.code}`),
      code: wilaya.code,
      wilaya_code: wilaya.code,
      name: wilaya.name,
      commune_name: 'Centre Ville',
    }
    : { id: Number(wilaya.code), code: wilaya.code, name: wilaya.name })
  return json({ data, total: data.length })
}

function createParcel(providerCode, config, body) {
  if (!config.required(body)) return json({ message: 'Missing required parcel fields' }, 422)
  const orderId = config.orderId(body)
  const existing = [...parcels.values()].find(parcel => (
    parcel.provider === providerCode && parcel.order_id === orderId
  ))
  if (existing) return json(statusOf(existing), 200) // idempotent replay

  sequence += 1
  const tracking = `${config.prefix}-${hash(`${providerCode}:${orderId}`)}-${String(sequence).padStart(4, '0')}`
  const externalId = providerCode === 'zrexpressnew'
    ? deterministicUuid(`zrnew:parcel:${tracking}`)
    : tracking
  const parcel = {
    tracking,
    external_id: externalId,
    provider: providerCode,
    order_id: orderId,
    customer_name: config.customer(body),
    contact_phone: config.phone(body),
    address: config.address(body),
    commune: config.commune(body),
    wilaya: config.wilaya(body),
    product_list: config.productList(body),
    price: config.price(body),
    delivery_fee: config.deliveryFee(body),
    note: config.note(body),
    last_status: config.initialStatus,
    created_at: new Date('2026-11-13T09:00:00Z').toISOString(),
    history: [{ status: config.initialStatus, at: '2026-11-13T09:00:00Z', label: config.initialLabel }],
    label: '',
    cancelled: false,
  }
  parcel.label = labelDataUrl(parcel)
  parcels.set(tracking, parcel)
  return json(statusOf(parcel), 201)
}

export function resetShippingMock() {
  parcels.clear()
  sequence = 1000
}

export function getMockParcel(tracking) {
  return parcels.get(String(tracking)) || null
}

export function listMockParcels() {
  return [...parcels.values()].map(parcel => ({ ...parcel }))
}

/**
 * Fetch-compatible mock of Yalidine + both ZR platforms. Credentials are
 * checked per platform so wrong keys, rate limits and idempotent replays can be
 * tested offline too.
 */
export function mockFetch(url, init = {}) {
  const requestUrl = new URL(String(url))
  const providerCode = HOST_TO_PROVIDER[requestUrl.hostname] || 'yalidine'
  const config = PROVIDER_CONFIG[providerCode]
  const path = requestUrl.pathname.replace(/^\/v1\/?/, '').replace(/^\/+|\/+$/g, '')
  const method = String(init?.method || 'GET').toUpperCase()

  const auth = config.auth(init)
  if (!auth.ok) return json({ message: 'Invalid courier credentials' }, 401)
  if (auth.values.some(value => /ratelimit/i.test(value))) {
    return json({ message: 'Too many requests' }, 429)
  }

  // ------------------------------------------------------------- connectivity
  if (path === '') return json({ ok: true, provider: `${providerCode}-mock`, mode: 'mock' })
  if (path === 'wilayas' || path === 'territories') return territoriesResponse(providerCode)
  if (path === 'communes') {
    const wilaya = requestUrl.searchParams.get('wilaya_id') || '16'
    return json({
      data: [
        { id: `${wilaya}-1`, name: 'Centre Ville', wilaya_id: Number(wilaya) },
        { id: `${wilaya}-2`, name: 'Cité Administrative', wilaya_id: Number(wilaya) },
      ],
    })
  }

  // -------------------------------------------------------------- create parcel
  if (path === 'parcels' && method === 'POST') {
    return createParcel(providerCode, config, bodyOf(init))
  }

  // ------------------------------------------------------------- list parcels
  if (path === 'parcels' && method === 'GET') {
    const rows = [...parcels.values()].filter(parcel => parcel.provider === providerCode).map(statusOf)
    return json({ data: rows, total: rows.length })
  }

  // ------------------------------------------------- single parcel / label / cancel
  const match = path.match(/^parcels\/([^/]+)(?:\/(label))?$/)
  if (match) {
    const tracking = decodeURIComponent(match[1])
    const parcel = parcels.get(tracking)
    if (!parcel || parcel.provider !== providerCode) return json({ message: 'Parcel not found' }, 404)

    if (match[2] === 'label') {
      return json({ tracking, label: parcel.label, url: parcel.label })
    }
    if (method === 'DELETE') {
      parcel.cancelled = true
      parcel.last_status = config.cancelStatus
      parcel.history.push({ status: config.cancelStatus, at: '2026-11-13T10:00:00Z', label: config.cancelLabel })
      return json(statusOf(parcel))
    }
    return json(statusOf(parcel))
  }

  return json({ message: `Unknown mock endpoint: ${method} ${path}` }, 404)
}

/** Convenience for tests: advance a parcel through a courier status. */
export function advanceMockParcel(tracking, rawStatus, label = '') {
  const parcel = parcels.get(String(tracking))
  if (!parcel) return null
  parcel.last_status = rawStatus
  parcel.history.push({ status: rawStatus, at: '2026-11-13T11:00:00Z', label: label || rawStatus })
  return parcel
}
