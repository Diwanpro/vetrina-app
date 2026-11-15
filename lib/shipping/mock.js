// In-memory Yalidine-shaped API used until real Sandbox keys are connected.
//
// Mock Fetch is a real `fetch`-compatible function: it returns a standard
// Response and never touches the network. It keeps parcel state between calls,
// so createShipment -> getTracking -> getLabel behaves like the courier would.
// Switching to the live API is one environment variable (SHIPPING_MOCK_MODE),
// not a code change.

import { WILAYAS } from '../wilayas.js'

const MOCK_ORIGIN = 'https://mock.yalidine.local/v1/'
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
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="420" height="260" viewBox="0 0 420 260">
<rect width="420" height="260" fill="#121212"/><rect x="10" y="10" width="400" height="240" fill="none" stroke="#D4AF37" stroke-width="2"/>
<text x="24" y="48" fill="#D4AF37" font-family="sans-serif" font-size="22">VETRINA · Yalidine (MOCK)</text>
<text x="24" y="92" fill="#ffffff" font-family="sans-serif" font-size="18">Tracking: ${escape(parcel.tracking)}</text>
<text x="24" y="124" fill="#ffffff" font-family="sans-serif" font-size="16">Order: ${escape(parcel.order_id)}</text>
<text x="24" y="156" fill="#ffffff" font-family="sans-serif" font-size="16">To: ${escape(parcel.firstname)} ${escape(parcel.familyname)}</text>
<text x="24" y="188" fill="#ffffff" font-family="sans-serif" font-size="16">COD: ${escape(parcel.price)} DZD</text>
<text x="24" y="228" fill="#888888" font-family="sans-serif" font-size="12">بورْدورو تجريبي — وضع المحاكاة</text>
</svg>`
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
}

function statusOf(parcel) {
  return {
    tracking: parcel.tracking,
    order_id: parcel.order_id,
    last_status: parcel.last_status,
    status: parcel.last_status,
    price: parcel.price,
    label: parcel.label,
    created_at: parcel.created_at,
    history: parcel.history,
  }
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
 * A fetch-compatible mock of the Yalidine v1 endpoints.
 * `X-API-ID` / `X-API-TOKEN` are checked so wrong keys can be tested too.
 */
export function mockFetch(url, init = {}) {
  const requestUrl = new URL(String(url))
  const path = requestUrl.pathname.replace(/^\/v1\/?/, '').replace(/^\/+|\/+$/g, '')
  const method = String(init?.method || 'GET').toUpperCase()

  const apiId = header(init, 'X-API-ID')
  const token = header(init, 'X-API-TOKEN')
  if (!apiId || !token || token === 'invalid' || apiId === 'invalid') {
    return json({ message: 'Invalid API ID or API Token' }, 401)
  }
  if (token.includes('ratelimit')) {
    return json({ message: 'Too many requests' }, 429)
  }

  // ------------------------------------------------------------- connectivity
  if (path === '' || path === 'wilayas') {
    if (path === '') return json({ ok: true, provider: 'yalidine-mock', mode: 'mock' })
    return json({
      data: WILAYAS.map(wilaya => ({ id: Number(wilaya.code), name: wilaya.name, code: wilaya.code })),
      total: WILAYAS.length,
    })
  }

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
    const body = bodyOf(init)
    if (!body.firstname || !body.contact_phone || !body.order_id) {
      return json({ message: 'Missing required parcel fields' }, 422)
    }
    const existing = [...parcels.values()].find(parcel => parcel.order_id === body.order_id)
    if (existing) return json(statusOf(existing), 200) // idempotent replay

    sequence += 1
    const tracking = `YAL-MOCK-${hash(body.order_id)}-${String(sequence).padStart(4, '0')}`
    const parcel = {
      tracking,
      id: tracking,
      order_id: body.order_id,
      firstname: body.firstname,
      familyname: body.familyname || '',
      contact_phone: body.contact_phone,
      address: body.address || '',
      to_commune_name: body.to_commune_name || '',
      to_wilaya_name: body.to_wilaya_name || '',
      from_wilaya_name: body.from_wilaya_name || '',
      product_list: body.product_list || '',
      price: Number(body.price) || 0,
      delivery_fee: Number(body.delivery_fee) || 0,
      is_stopdesk: Boolean(body.is_stopdesk),
      last_status: 'Créé',
      created_at: new Date('2026-11-13T09:00:00Z').toISOString(),
      history: [{ status: 'Créé', at: '2026-11-13T09:00:00Z', label: 'تم إنشاء الطرد' }],
      label: '',
      cancelled: false,
    }
    parcel.label = labelDataUrl(parcel)
    parcels.set(tracking, parcel)
    return json(statusOf(parcel), 201)
  }

  // ------------------------------------------------------------- list parcels
  if (path === 'parcels' && method === 'GET') {
    return json({ data: [...parcels.values()].map(statusOf), total: parcels.size })
  }

  // ------------------------------------------------- single parcel / label / cancel
  const match = path.match(/^parcels\/([^/]+)(?:\/(label))?$/)
  if (match) {
    const tracking = decodeURIComponent(match[1])
    const parcel = parcels.get(tracking)
    if (!parcel) return json({ message: 'Parcel not found' }, 404)

    if (match[2] === 'label') {
      return json({ tracking, label: parcel.label, url: parcel.label })
    }
    if (method === 'DELETE') {
      parcel.cancelled = true
      parcel.last_status = 'Annulé'
      parcel.history.push({ status: 'Annulé', at: '2026-11-13T10:00:00Z', label: 'تم إلغاء الطرد' })
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

export const MOCK_BASE_URL = MOCK_ORIGIN
