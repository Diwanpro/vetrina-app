// SERVER-ONLY facade for the P2 shipping gateway.
//
// Every request is authenticated with the caller's Supabase JWT, re-checked
// against engine_session + engine_staff (owner/manager, correct branch, live
// subscription), and only then allowed to write through the service-role
// client. Plaintext credentials exist in memory for the duration of one request
// and are never returned, logged or stored in the browser.
//
// P3+ adapters will replace runProbe()/testConnection() internals with real
// courier calls; the route handlers and the UI contract stay unchanged.

import { createClient } from '@supabase/supabase-js'
import {
  ShippingError, shippingError, normalizeProviderCode, isEnvironment,
  isConnectionMode, isValidWilayaCode, isValidUuid,
} from './contract.js'
import {
  getProvider, listProviders, credentialHintField, validateCredentials, buildProbeRequest,
} from './registry.js'
import {
  encryptCredentials, decryptCredentials, credentialHint, connectionAad,
} from './credentials.js'

export { listProviders }

function serverEnv() {
  const url = String(process.env.NEXT_PUBLIC_SUPABASE_URL || '').trim()
  const anonKey = String(process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '').trim()
  const serviceKey = String(process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim()
  if (!url || !anonKey || !serviceKey) {
    throw new ShippingError('CONFIG', 'إعدادات السيرفر غير مكتملة (SUPABASE_SERVICE_ROLE_KEY مطلوب).', 500)
  }
  return { url, anonKey, serviceKey }
}

function bearer(request) {
  const header = request.headers.get('authorization') || ''
  const match = header.match(/^Bearer\s+(.+)$/i)
  if (!match?.[1]) throw new ShippingError('AUTH', 'يرجى تسجيل الدخول مجدداً', 401)
  return match[1].trim()
}

/**
 * Verifies the JWT, the staff profile and the branch. Returns a user-scoped
 * client (for masked RPCs) and a service-role client (for secret writes).
 */
export async function authorize(request, storeId) {
  if (!isValidUuid(storeId)) throw new ShippingError('VALIDATION', 'معرّف الفرع غير صالح', 400)
  const token = bearer(request)
  const { url, anonKey, serviceKey } = serverEnv()

  const userClient = createClient(url, anonKey, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  })

  const { data: identity, error: authError } = await userClient.auth.getUser()
  if (authError || !identity?.user) throw new ShippingError('AUTH', 'انتهت الجلسة، سجّل الدخول مجدداً', 401)

  const { data: ctx, error: sessionError } = await userClient.rpc('engine_session')
  if (sessionError || !ctx?.staffId) {
    throw new ShippingError('AUTH', 'تعذر التحقق من ملف الموظف', 401)
  }
  if (!['owner', 'manager'].includes(ctx.role)) {
    throw new ShippingError('AUTH', 'ربط شركات التوصيل متاح للمالك أو المدير فقط', 403)
  }
  if (!Array.isArray(ctx.stores) || !ctx.stores.some(store => store.id === storeId)) {
    throw new ShippingError('AUTH', 'غير مصرح لهذا الفرع', 403)
  }

  // engine_staff also rejects an expired subscription, exactly like the other
  // settings RPCs (engine_update_delivery_rates).
  const { error: staffError } = await userClient.rpc('engine_staff', {
    p_store: storeId,
    p_tenant: ctx.tenantId,
  })
  if (staffError) throw new ShippingError('AUTH', staffError.message || 'غير مصرح لهذا الفرع', 403)

  const adminClient = createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  })
  return { ctx, userClient, adminClient }
}

export function errorResponse(error) {
  if (error instanceof ShippingError) {
    return { status: error.status, body: { error: error.message, code: error.code } }
  }
  // Unexpected errors must not leak SQL/driver details to the dashboard.
  return { status: 500, body: { error: 'حدث خطأ غير متوقع. حاول مجدداً.', code: 'INTERNAL' } }
}

function validateTarget(providerCode, environment, mode = null) {
  const code = normalizeProviderCode(providerCode)
  const provider = getProvider(code)
  if (!provider) throw new ShippingError('VALIDATION', 'شركة التوصيل غير معروفة', 400)
  if (!isEnvironment(environment)) throw new ShippingError('VALIDATION', 'بيئة التشغيل غير صالحة', 400)
  if (mode !== null && !isConnectionMode(mode)) throw new ShippingError('VALIDATION', 'استراتيجية الربط غير صالحة', 400)
  return { code, provider, environment }
}

function validateDefaults(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  const deliveryType = source.deliveryType === 'stopdesk' ? 'stopdesk' : 'home'
  const autoShip = source.autoShip === true
  const stopDeskId = typeof source.stopDeskId === 'string' ? source.stopDeskId.trim().slice(0, 80) : ''
  return { deliveryType, autoShip, stopDeskId }
}

function masked(row) {
  if (!row) return null
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    store_id: row.store_id,
    provider_code: row.provider_code,
    environment: row.environment,
    mode: row.mode,
    enabled: row.enabled,
    credentials_hint: row.credentials_hint || '',
    origin_wilaya_code: row.origin_wilaya_code || '',
    defaults: row.defaults || {},
    last_test_at: row.last_test_at || null,
    last_test_ok: row.last_test_ok ?? null,
    last_test_mode: row.last_test_mode || null,
    last_test_message: row.last_test_message || null,
    created_at: row.created_at || null,
    updated_at: row.updated_at || null,
  }
}

const PUBLIC_COLUMNS =
  'id, tenant_id, store_id, provider_code, environment, mode, enabled, credentials_ciphertext, ' +
  'credentials_hint, origin_wilaya_code, defaults, last_test_at, last_test_ok, last_test_mode, ' +
  'last_test_message, created_by, updated_by, created_at, updated_at'

/** Masked list through the definer RPC, never a direct table SELECT. */
export async function listConnections(userClient, storeId) {
  const { data, error } = await userClient.rpc('engine_list_shipping_connections', { p_store: storeId })
  if (error) throw new ShippingError('AUTH', error.message || 'تعذر قراءة إعدادات الربط', 403)
  return Array.isArray(data) ? data.map(masked) : []
}

export async function findConnection(adminClient, { tenantId, storeId, providerCode, environment }) {
  const { data, error } = await adminClient
    .from('shipping_connections')
    .select(PUBLIC_COLUMNS)
    .eq('tenant_id', tenantId)
    .eq('store_id', storeId)
    .eq('provider_code', providerCode)
    .eq('environment', environment)
    .maybeSingle()
  if (error) throw shippingError('INTERNAL', 'تعذر قراءة إعدادات الربط', 500)
  return data || null
}

function resolveCredentials({ provider, mode, inputCredentials, existing, aad }) {
  if (mode === 'bulk') return { ciphertext: null, hint: '', clean: null }
  if (inputCredentials && typeof inputCredentials === 'object') {
    const check = validateCredentials(provider, inputCredentials, mode)
    if (!check.ok) throw new ShippingError('VALIDATION', check.errors.join(' · '), 400)
    return {
      ciphertext: encryptCredentials(check.clean, aad),
      hint: credentialHint(check.clean, credentialHintField(provider)?.key),
      clean: check.clean,
    }
  }
  if (existing?.credentials_ciphertext) {
    return {
      ciphertext: existing.credentials_ciphertext,
      hint: existing.credentials_hint || '••••',
      clean: decryptCredentials(existing.credentials_ciphertext, aad),
    }
  }
  throw new ShippingError('VALIDATION', 'أدخل مفاتيح الشركة أولاً ثم احفظها', 400)
}

/** Upserts one connection. An omitted credentials object keeps the saved keys. */
export async function saveConnection({ adminClient, ctx, storeId, input }) {
  const { code, provider, environment } = validateTarget(input.providerCode, input.environment, input.mode)
  const mode = input.mode
  const origin = input.originWilayaCode == null ? '' : String(input.originWilayaCode).trim()
  if (origin && !isValidWilayaCode(origin)) throw new ShippingError('VALIDATION', 'ولاية الانطلاق غير صالحة', 400)
  if (provider.originWilayaRequired && mode !== 'bulk' && !origin) {
    throw new ShippingError('VALIDATION', `${provider.label} يتطلب ولاية الانطلاق`, 400)
  }

  const aad = connectionAad({ tenantId: ctx.tenantId, storeId, providerCode: code, environment })
  const existing = await findConnection(adminClient, {
    tenantId: ctx.tenantId, storeId, providerCode: code, environment,
  })
  const resolved = resolveCredentials({
    provider, mode, inputCredentials: input.credentials, existing, aad,
  })

  const payload = {
    tenant_id: ctx.tenantId,
    store_id: storeId,
    provider_code: code,
    environment,
    mode,
    enabled: input.enabled !== false,
    credentials_ciphertext: resolved.ciphertext,
    credentials_hint: resolved.hint,
    origin_wilaya_code: origin || null,
    defaults: validateDefaults(input.defaults),
    created_by: existing?.created_by || ctx.staffId,
    updated_by: ctx.staffId,
    updated_at: new Date().toISOString(),
  }

  const { data, error } = await adminClient
    .from('shipping_connections')
    .upsert(payload, { onConflict: 'store_id,provider_code,environment' })
    .select(PUBLIC_COLUMNS)
    .single()
  if (error) throw shippingError('INTERNAL', `تعذر حفظ الإعدادات: ${error.message}`, 500)
  return masked(data)
}

/** Soft disable: secrets are cleared, the audit trail is kept. */
export async function disableConnection({ adminClient, ctx, storeId, input }) {
  const { code, environment } = validateTarget(input.providerCode, input.environment)
  const { error } = await adminClient
    .from('shipping_connections')
    .update({
      enabled: false,
      credentials_ciphertext: null,
      credentials_hint: '',
      updated_by: ctx.staffId,
      updated_at: new Date().toISOString(),
    })
    .eq('tenant_id', ctx.tenantId)
    .eq('store_id', storeId)
    .eq('provider_code', code)
    .eq('environment', environment)
  if (error) throw shippingError('INTERNAL', 'تعذر تعطيل الربط', 500)
  return true
}

/**
 * Live probe when SHIPPING_<CODE>_<ENV>_BASE_URL is configured; otherwise a
 * deterministic local validation with an explicit "local" mode so the UI never
 * claims a network test happened. P3 replaces this with adapter.testConnection.
 */
export async function runProbe(probe) {
  const started = Date.now()
  try {
    const response = await fetch(probe.url, {
      method: probe.method,
      headers: probe.headers,
      signal: AbortSignal.timeout(probe.timeoutMs),
      cache: 'no-store',
    })
    const latencyMs = Date.now() - started
    // Deliberately do not read the body: it may echo account details.
    const status = response.status
    let result
    if (response.ok) {
      result = { ok: true, code: 'OK', message: `الاتصال ناجح (HTTP ${status})` }
    } else if (status === 401 || status === 403) {
      result = { ok: false, code: 'AUTH_FAILED', message: `الشركة رفضت المفاتيح (HTTP ${status})` }
    } else if (status === 429) {
      result = { ok: false, code: 'RATE_LIMITED', message: 'الشركة تطلب التباطؤ، أعد المحاولة لاحقاً' }
    } else {
      result = { ok: false, code: 'PROVIDER_ERROR', message: `الخادم استجاب بـ HTTP ${status}` }
    }
    return { ...result, mode: 'live', reachable: true, httpStatus: status, latencyMs }
  } catch {
    return {
      ok: false, mode: 'live', reachable: false, code: 'NETWORK_ERROR',
      message: 'تعذر الوصول إلى خادم الشركة. تحقق من عنوان Sandbox والاتصال.',
      httpStatus: null, latencyMs: Date.now() - started,
    }
  }
}

export async function testConnection({ adminClient, ctx, storeId, input }) {
  const { code, provider, environment } = validateTarget(input.providerCode, input.environment)
  const existing = await findConnection(adminClient, {
    tenantId: ctx.tenantId, storeId, providerCode: code, environment,
  })
  const mode = input.mode || existing?.mode || 'api'
  if (!isConnectionMode(mode)) throw new ShippingError('VALIDATION', 'استراتيجية الربط غير صالحة', 400)

  if (mode === 'bulk') {
    return {
      ok: true, mode: 'local', reachable: false, code: 'BULK_MODE',
      message: 'وضع التصدير بالجملة لا يحتاج إلى مفاتيح API.', httpStatus: null, latencyMs: null,
    }
  }

  const aad = connectionAad({ tenantId: ctx.tenantId, storeId, providerCode: code, environment })
  const resolved = resolveCredentials({
    provider, mode, inputCredentials: input.credentials, existing, aad,
  })
  const clean = resolved.clean || validateCredentials(provider, input.credentials, mode).clean
  const probe = buildProbeRequest(provider, clean, environment, process.env)

  let result
  if (!probe) {
    result = {
      ok: true, mode: 'local', reachable: false, code: 'LOCAL_ONLY',
      message: 'تم التحقق من صحة المفاتيح محلياً. لم يُضبط عنوان Sandbox بعد؛ الفحص الفعلي يُكمله محوّل الشركة في P3.',
      httpStatus: null, latencyMs: null,
    }
  } else {
    result = await runProbe(probe)
  }

  if (existing) {
    await adminClient
      .from('shipping_connections')
      .update({
        last_test_at: new Date().toISOString(),
        last_test_ok: result.ok,
        last_test_mode: result.mode,
        last_test_message: String(result.message).slice(0, 300),
      })
      .eq('id', existing.id)
  }
  return result
}
