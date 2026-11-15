// SERVER-ONLY transport: chooses the live courier API or the in-memory mock.
//
// P3/P4 ship without Sandbox keys, so `SHIPPING_MOCK_MODE=true` (already set
// on Vercel) routes every adapter call through mockFetch. Later, setting
// SHIPPING_MOCK_MODE=false together with SHIPPING_<CODE>_<ENV>_BASE_URL flips
// the very same adapter to the real API; no adapter code changes.

import { ShippingError } from './contract.js'
import { mockFetch, MOCK_BASE_URL, MOCK_BASE_URLS } from './mock.js'

const LIVE_DEFAULTS = Object.freeze({ yalidine: 'https://api.yalidine.app/v1/' })

export function baseUrlVariable(provider, environment) {
  return `SHIPPING_${provider.code.toUpperCase()}_${String(environment).toUpperCase()}_BASE_URL`
}

/** 'mock' | 'live'. Explicit SHIPPING_MOCK_MODE always wins. */
export function shippingMode(env, provider, environment) {
  const explicit = String(env?.SHIPPING_MOCK_MODE ?? '').trim().toLowerCase()
  if (['true', '1', 'mock', 'yes'].includes(explicit)) return 'mock'
  if (['false', '0', 'live', 'no'].includes(explicit)) return 'live'
  // Sensible default: without a configured Sandbox endpoint we stay offline.
  return String(env?.[baseUrlVariable(provider, environment)] || '').trim() ? 'live' : 'mock'
}

export function resolveBaseUrl(env, provider, environment, mode = shippingMode(env, provider, environment)) {
  // Each courier has its own deterministic mock origin, so ZR adapters can use
  // the very same shippingRequest() without a Yalidine-shaped URL.
  if (mode === 'mock') return MOCK_BASE_URLS[provider.code] || MOCK_BASE_URL
  const configured = String(env?.[baseUrlVariable(provider, environment)] || '').trim()
  return configured || LIVE_DEFAULTS[provider.code] || ''
}

function joinUrl(base, path) {
  const root = base.endsWith('/') ? base : `${base}/`
  return new URL(String(path || '').replace(/^\/+/, ''), root).toString()
}

function mapHttpError(status, data) {
  const detail = data && typeof data === 'object' ? (data.message || data.error || '') : ''
  const suffix = detail ? ` — ${String(detail).slice(0, 160)}` : ''
  if (status === 401 || status === 403) {
    return new ShippingError('AUTH_FAILED', `شركة التوصيل رفضت المفاتيح (HTTP ${status})${suffix}`, 401)
  }
  if (status === 429) {
    return new ShippingError('RATE_LIMITED', 'الشركة تطلب التباطؤ، أعد المحاولة لاحقاً', 429)
  }
  if (status === 400 || status === 422) {
    return new ShippingError('VALIDATION_ERROR', `بيانات الطرد غير مقبولة لدى الشركة (HTTP ${status})${suffix}`, 400)
  }
  if (status === 404) {
    return new ShippingError('NOT_FOUND', 'الطرد غير موجود لدى الشركة', 404)
  }
  return new ShippingError('PROVIDER_ERROR', `خطأ من شركة التوصيل (HTTP ${status})${suffix}`, 502)
}

/**
 * One authorised request. Returns { data, status, mode, url }.
 * Non-2xx responses become classified ShippingError objects.
 */
export async function shippingRequest({
  provider,
  environment = 'sandbox',
  path = '',
  method = 'GET',
  body = null,
  headers = {},
  env = process.env,
  fetchImpl = null,
}) {
  if (!provider) throw new ShippingError('VALIDATION', 'شركة التوصيل غير معروفة', 400)
  const mode = shippingMode(env, provider, environment)
  const base = resolveBaseUrl(env, provider, environment, mode)
  if (!base) throw new ShippingError('CONFIG', `لم يُضبط عنوان API لـ ${provider.code}`, 500)
  const url = joinUrl(base, path)

  const chosen = fetchImpl || (mode === 'mock' ? mockFetch : globalThis.fetch)
  if (typeof chosen !== 'function') throw new ShippingError('CONFIG', 'لا يوجد تنفيذ متاح للاتصال', 500)

  const init = {
    method,
    cache: 'no-store',
    headers: { Accept: 'application/json', ...(body != null ? { 'Content-Type': 'application/json' } : {}), ...headers },
  }
  if (body != null) init.body = JSON.stringify(body)

  let response
  try {
    response = await chosen(url, init)
  } catch {
    throw new ShippingError('NETWORK_ERROR', 'تعذر الوصول إلى خادم شركة التوصيل', 502)
  }
  if (!response || typeof response.status !== 'number') {
    throw new ShippingError('PROVIDER_ERROR', 'استجابة غير صالحة من شركة التوصيل', 502)
  }

  let data = null
  try { data = await response.json() } catch { data = null }
  if (!response.ok) throw mapHttpError(response.status, data)
  return { data, status: response.status, mode, url }
}
