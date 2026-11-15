// SERVER-ONLY facade for the shipping gateway (P2 + P3).
//
// Every request is authenticated with the caller's Supabase JWT, re-checked
// against engine_session + engine_staff (owner/manager, correct branch, live
// subscription), and only then allowed to write through the service-role
// client. Plaintext credentials exist in memory for one request and are never
// returned, logged or stored in the browser.
//
// P3 addition: shipOrder/syncShipment/cancelShipment/getShipmentLabel plus the
// Yalidine webhook. public.orders is ONLY read through the definer RPC
// engine_order_shipping_snapshot — never written, never altered.

import { createHash } from 'node:crypto'
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
import { getAdapter } from './adapters.js'

export { listProviders }

const MOCK_WEBHOOK_SECRET = 'vetrina-mock-webhook-secret'

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

/** Service-role client without a user JWT: used only by signed webhooks. */
export function webhookAdminClient() {
  const { url, serviceKey } = serverEnv()
  return createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  })
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

const SHIPMENT_COLUMNS =
  'id, tenant_id, store_id, order_id, provider_code, environment, mode, external_id, ' +
  'tracking_number, status, raw_status, label_url, cod_amount, delivery_fee, ' +
  'request_snapshot, response_snapshot, idempotency_key, last_error, last_synced_at, created_at, updated_at'

function shipmentView(row) {
  if (!row) return null
  return {
    id: row.id,
    order_id: row.order_id,
    provider_code: row.provider_code,
    environment: row.environment,
    mode: row.mode,
    external_id: row.external_id || '',
    tracking_number: row.tracking_number || '',
    status: row.status,
    raw_status: row.raw_status || '',
    label_url: row.label_url || '',
    cod_amount: row.cod_amount,
    delivery_fee: row.delivery_fee,
    last_synced_at: row.last_synced_at || null,
    last_error: row.last_error || null,
    created_at: row.created_at || null,
  }
}

/** Masked list through the definer RPC, never a direct table SELECT. */
export async function listConnections(userClient, storeId) {
  const { data, error } = await userClient.rpc('engine_list_shipping_connections', { p_store: storeId })
  if (error) throw new ShippingError('AUTH', error.message || 'تعذر قراءة إعدادات الربط', 403)
  return Array.isArray(data) ? data.map(masked) : []
}

export async function listShipments(userClient, storeId) {
  const { data, error } = await userClient.rpc('engine_list_shipments', { p_store: storeId })
  if (error) throw new ShippingError('AUTH', error.message || 'تعذر قراءة الشحنات', 403)
  return Array.isArray(data) ? data.map(shipmentView) : []
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
 * Live probe used only for providers that have no adapter yet. P3 adapters
 * (Yalidine) implement their own testConnection and take precedence.
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

async function recordTest(adminClient, existing, result) {
  if (!existing) return
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
  const adapter = getAdapter(code)

  let result
  if (adapter?.capabilities?.test && adapter.testConnection) {
    result = await adapter.testConnection(clean, environment, process.env)
  } else {
    const probe = buildProbeRequest(provider, clean, environment, process.env)
    result = probe
      ? await runProbe(probe)
      : {
        ok: true, mode: 'local', reachable: false, code: 'LOCAL_ONLY',
        message: 'تم التحقق من صحة المفاتيح محلياً. لم يُضبط عنوان Sandbox بعد.',
        httpStatus: null, latencyMs: null,
      }
  }

  await recordTest(adminClient, existing, result)
  return result
}

// ------------------------------------------------------------------- P3: API
function shipmentRequestFrom(snapshot, connection) {
  const items = Array.isArray(snapshot.items) ? snapshot.items : []
  const productList = items.map(item => {
    const variant = [item.color, item.size].filter(Boolean).join(' · ')
    return `${item.product_name || ''}${variant ? ` — ${variant}` : ''}${item.qty ? ` ×${item.qty}` : ''}`
  }).filter(Boolean).join(' · ').slice(0, 250)
  const defaults = connection.defaults && typeof connection.defaults === 'object' ? connection.defaults : {}
  return {
    orderId: snapshot.id,
    orderNumber: snapshot.order_number,
    customerName: snapshot.customer_name,
    customerPhone: snapshot.customer_phone,
    wilayaCode: snapshot.wilaya_code,
    commune: snapshot.commune,
    address: snapshot.address,
    note: snapshot.note,
    codAmount: Number(snapshot.total) || 0,
    deliveryFee: Number(snapshot.delivery_fee) || 0,
    items,
    productList,
    deliveryType: defaults.deliveryType === 'stopdesk' ? 'stopdesk' : 'home',
    stopDeskId: defaults.stopDeskId || '',
    originWilayaCode: connection.origin_wilaya_code || '',
  }
}

function canonicalToShipmentStatus(canonical, fallback) {
  return ['created', 'in_transit', 'delivered', 'returned', 'cancelled'].includes(canonical)
    ? canonical
    : fallback
}

async function activeCredentials(adminClient, ctx, storeId, row) {
  const connection = await findConnection(adminClient, {
    tenantId: ctx.tenantId, storeId,
    providerCode: row.provider_code, environment: row.environment,
  })
  if (!connection?.enabled || !connection.credentials_ciphertext) {
    throw new ShippingError('VALIDATION', 'ربط شركة التوصيل معطّل أو مفاتيحه محذوفة', 400)
  }
  const aad = connectionAad({
    tenantId: ctx.tenantId, storeId,
    providerCode: row.provider_code, environment: row.environment,
  })
  return { connection, credentials: decryptCredentials(connection.credentials_ciphertext, aad) }
}

/** Creates a parcel, then writes ONLY to shipments / shipment_events. */
export async function shipOrder({ adminClient, userClient, ctx, storeId, input }) {
  const { code, provider, environment } = validateTarget(
    input.providerCode || 'yalidine', input.environment || 'sandbox',
  )
  const adapter = getAdapter(code)
  if (!adapter?.capabilities?.create) {
    throw new ShippingError('NOT_SUPPORTED', `محوّل ${provider.label} غير مفعّل بعد (P4)`, 400)
  }
  if (!isValidUuid(input.orderId)) throw new ShippingError('VALIDATION', 'معرّف الطلب غير صالح', 400)

  const connection = await findConnection(adminClient, {
    tenantId: ctx.tenantId, storeId, providerCode: code, environment,
  })
  if (!connection?.enabled) throw new ShippingError('VALIDATION', 'لم يُفعّل ربط شركة التوصيل لهذا الفرع', 400)
  if (!['api', 'both'].includes(connection.mode)) {
    throw new ShippingError('VALIDATION', 'هذا الربط مضبوط على التصدير بالجملة فقط', 400)
  }
  const aad = connectionAad({ tenantId: ctx.tenantId, storeId, providerCode: code, environment })
  const credentials = decryptCredentials(connection.credentials_ciphertext, aad)

  // Read the order exclusively through the definer RPC. No direct SELECT on
  // public.orders and absolutely no write to it.
  const { data: snapshot, error: rpcError } = await userClient
    .rpc('engine_order_shipping_snapshot', { p_order_id: input.orderId })
  if (rpcError || !snapshot) {
    throw new ShippingError('NOT_FOUND', rpcError?.message || 'الطلب غير موجود أو غير مصرح', 404)
  }
  if (snapshot.store_id !== storeId || snapshot.tenant_id !== ctx.tenantId) {
    throw new ShippingError('AUTH', 'الطلب لا يتبع هذا الفرع', 403)
  }
  if (snapshot.fulfillment_type !== 'delivery') {
    throw new ShippingError('VALIDATION', 'الطلب استلام من المحل ولا يحتاج شحناً', 400)
  }
  if (!['confirmed', 'preparing'].includes(snapshot.status)) {
    throw new ShippingError('VALIDATION', 'يُشحن الطلب بعد تأكيده أو أثناء تحضيره فقط', 400)
  }

  const { data: active } = await adminClient
    .from('shipments')
    .select('id, tracking_number')
    .eq('order_id', input.orderId)
    .eq('provider_code', code)
    .in('status', ['created', 'in_transit', 'delivered', 'returned', 'exported'])
    .maybeSingle()
  if (active) {
    throw new ShippingError('CONFLICT', `الطلب مشحون بالفعل · ${active.tracking_number || ''}`, 409)
  }

  const request = shipmentRequestFrom(snapshot, connection)
  const created = await adapter.createShipment(request, credentials, {
    environment, env: process.env, connection,
  })

  // A cancelled/failed shipment frees the partial unique index but retains its
  // idempotency key. Count previous attempts so re-shipping produces a fresh
  // key while a replay of the SAME attempt still collides (and stays safe).
  const { data: previous, error: previousError } = await adminClient
    .from('shipments')
    .select('id')
    .eq('tenant_id', ctx.tenantId)
    .eq('store_id', storeId)
    .eq('order_id', input.orderId)
    .eq('provider_code', code)
    .eq('environment', environment)
  if (previousError) throw shippingError('INTERNAL', 'تعذر التحقق من محاولات الشحن السابقة', 500)
  const attempt = (Array.isArray(previous) ? previous.length : 0) + 1

  const idempotencyKey = createHash('sha256')
    .update(`${ctx.tenantId}:${storeId}:${input.orderId}:${code}:${environment}:${attempt}`)
    .digest('hex')
  const now = new Date().toISOString()
  const payload = {
    tenant_id: ctx.tenantId,
    store_id: storeId,
    order_id: input.orderId,
    provider_code: code,
    environment,
    mode: 'api',
    external_id: created.externalId || created.trackingNumber,
    tracking_number: created.trackingNumber,
    status: 'created',
    raw_status: created.rawStatus || 'Créé',
    label_url: String(created.labelUrl || '').slice(0, 2000),
    cod_amount: Math.max(0, Math.round(request.codAmount)),
    delivery_fee: Math.max(0, Math.round(request.deliveryFee)),
    request_snapshot: request,
    response_snapshot: {
      tracking: created.trackingNumber, external_id: created.externalId,
      mode: created.mode, http_status: created.httpStatus,
    },
    idempotency_key: idempotencyKey,
    last_synced_at: now,
    created_at: now,
    updated_at: now,
  }

  const { data: row, error: insertError } = await adminClient
    .from('shipments')
    .insert(payload)
    .select(SHIPMENT_COLUMNS)
    .single()
  if (insertError) {
    if (insertError.code === '23505') {
      throw new ShippingError('CONFLICT', 'تم شحن هذا الطلب من قبل، حدّث القائمة', 409)
    }
    throw shippingError('INTERNAL', `تعذر تسجيل الشحنة: ${insertError.message}`, 500)
  }

  await adminClient.from('shipment_events').upsert({
    tenant_id: ctx.tenantId,
    shipment_id: row.id,
    provider_code: code,
    event_key: `yalidine:${created.trackingNumber}:created:${now}`,
    raw_status: created.rawStatus || 'Créé',
    canonical_status: 'created',
    occurred_at: now,
    payload: { order_number: snapshot.order_number, mode: created.mode },
  }, { onConflict: 'provider_code,event_key', ignoreDuplicates: true })

  return { shipment: shipmentView(row), trackingNumber: created.trackingNumber, labelUrl: created.labelUrl, mode: created.mode }
}

async function findShipment(adminClient, ctx, storeId, shipmentId) {
  const { data, error } = await adminClient
    .from('shipments')
    .select(SHIPMENT_COLUMNS)
    .eq('id', shipmentId)
    .eq('tenant_id', ctx.tenantId)
    .eq('store_id', storeId)
    .maybeSingle()
  if (error) throw shippingError('INTERNAL', 'تعذر قراءة الشحنة', 500)
  if (!data) throw new ShippingError('NOT_FOUND', 'الشحنة غير موجودة', 404)
  return data
}

export async function syncShipment({ adminClient, ctx, storeId, shipmentId }) {
  const row = await findShipment(adminClient, ctx, storeId, shipmentId)
  const adapter = getAdapter(row.provider_code)
  if (!adapter?.capabilities?.track) {
    throw new ShippingError('NOT_SUPPORTED', 'تتبّع هذه الشركة غير مفعّل بعد', 400)
  }
  const { credentials } = await activeCredentials(adminClient, ctx, storeId, row)
  const tracking = await adapter.getTracking(row.tracking_number, credentials, {
    environment: row.environment, env: process.env,
  })
  const now = new Date().toISOString()
  const nextStatus = canonicalToShipmentStatus(tracking.status, row.status)

  const { data: updated, error } = await adminClient
    .from('shipments')
    .update({
      status: nextStatus,
      raw_status: tracking.rawStatus,
      last_synced_at: now,
      last_error: null,
      updated_at: now,
    })
    .eq('id', row.id)
    .select(SHIPMENT_COLUMNS)
    .single()
  if (error) throw shippingError('INTERNAL', 'تعذر تحديث حالة الشحنة', 500)

  for (const event of tracking.events) {
    await adminClient.from('shipment_events').upsert({
      tenant_id: ctx.tenantId,
      shipment_id: row.id,
      provider_code: row.provider_code,
      event_key: event.eventKey,
      raw_status: event.rawStatus,
      canonical_status: event.canonicalStatus,
      occurred_at: event.occurredAt || now,
      payload: { label: event.label || '' },
    }, { onConflict: 'provider_code,event_key', ignoreDuplicates: true })
  }

  return { shipment: shipmentView(updated), tracking: { status: tracking.status, rawStatus: tracking.rawStatus, events: tracking.events.length } }
}

export async function getShipmentLabel({ adminClient, ctx, storeId, shipmentId }) {
  const row = await findShipment(adminClient, ctx, storeId, shipmentId)
  if (row.label_url) return { labelUrl: row.label_url, trackingNumber: row.tracking_number }
  const adapter = getAdapter(row.provider_code)
  if (!adapter?.capabilities?.label) {
    throw new ShippingError('NOT_SUPPORTED', 'ملصق هذه الشركة غير مفعّل بعد', 400)
  }
  const { credentials } = await activeCredentials(adminClient, ctx, storeId, row)
  const label = await adapter.getLabel(row.tracking_number, credentials, {
    environment: row.environment, env: process.env,
  })
  await adminClient.from('shipments').update({ label_url: label.labelUrl.slice(0, 2000) }).eq('id', row.id)
  return { labelUrl: label.labelUrl, trackingNumber: row.tracking_number }
}

export async function cancelShipment({ adminClient, ctx, storeId, shipmentId }) {
  const row = await findShipment(adminClient, ctx, storeId, shipmentId)
  const adapter = getAdapter(row.provider_code)
  if (adapter?.capabilities?.cancel && row.tracking_number) {
    const { credentials } = await activeCredentials(adminClient, ctx, storeId, row)
    await adapter.cancelShipment(row.tracking_number, credentials, {
      environment: row.environment, env: process.env,
    })
  }
  const { data, error } = await adminClient
    .from('shipments')
    .update({ status: 'cancelled', updated_at: new Date().toISOString() })
    .eq('id', row.id)
    .select(SHIPMENT_COLUMNS)
    .single()
  if (error) throw shippingError('INTERNAL', 'تعذر إلغاء الشحنة', 500)
  return { shipment: shipmentView(data) }
}

/** Signed courier webhook: verifies the raw body before any DB write. */
export async function handleShippingWebhook({ adminClient, providerCode, rawBody, headers, env = process.env }) {
  const code = normalizeProviderCode(providerCode)
  const adapter = getAdapter(code)
  if (!adapter?.capabilities?.webhook) {
    throw new ShippingError('NOT_SUPPORTED', 'ويبهوك هذه الشركة غير مفعّل', 400)
  }
  const secret = String(env[`SHIPPING_${code.toUpperCase()}_WEBHOOK_SECRET`] || '').trim() || MOCK_WEBHOOK_SECRET
  if (!adapter.verifyWebhook(rawBody, headers, secret)) {
    throw new ShippingError('AUTH', 'توقيع الويبهوك غير صالح', 401)
  }

  let payload
  try { payload = JSON.parse(rawBody) } catch {
    throw new ShippingError('VALIDATION', 'جسم الويبهوك ليس JSON صالحاً', 400)
  }
  const events = adapter.parseWebhook(payload)
  let updated = 0
  for (const event of events) {
    const { data: row } = await adminClient
      .from('shipments')
      .select('id, tenant_id, status')
      .eq('tracking_number', event.trackingNumber)
      .eq('provider_code', code)
      .maybeSingle()
    if (!row) continue
    const nextStatus = canonicalToShipmentStatus(event.canonicalStatus, row.status)
    await adminClient.from('shipments').update({
      status: nextStatus,
      raw_status: event.rawStatus,
      last_synced_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }).eq('id', row.id)
    await adminClient.from('shipment_events').upsert({
      tenant_id: row.tenant_id,
      shipment_id: row.id,
      provider_code: code,
      event_key: event.eventKey,
      raw_status: event.rawStatus,
      canonical_status: event.canonicalStatus,
      occurred_at: event.occurredAt || new Date().toISOString(),
      payload: { source: 'webhook' },
    }, { onConflict: 'provider_code,event_key', ignoreDuplicates: true })
    updated += 1
  }
  return { received: events.length, updated, secretUsed: secret !== MOCK_WEBHOOK_SECRET ? 'configured' : 'mock' }
}
