// SERVER-ONLY CSV bulk-export gateway (P4).
//
// Reads orders ONLY through the definer RPC engine_shipping_export_candidates;
// never writes to public.orders. Writes go to shipping_export_batches,
// shipping_export_items and a `mode='bulk', status='exported'` shipments row,
// so the same order cannot be exported twice. CSV text comes from the existing
// csvText() helper (UTF-8 BOM, no new dependency).

import { createHash } from 'node:crypto'
import { csvText } from '../access.js'
import {
  ShippingError, shippingError, normalizeProviderCode, isEnvironment, isValidUuid,
} from './contract.js'
import { getProvider } from './registry.js'
import { getAdapter } from './adapters.js'
import { findConnection, validateTarget } from './index.js'
import { shipmentRequestFrom } from './request.js'

const EXPORT_STATUSES = Object.freeze(['confirmed', 'preparing'])

function fileName(prefix, environment, now = new Date()) {
  const safePrefix = String(prefix || 'shipping').replace(/[^a-z0-9_-]/gi, '-').toLowerCase()
  const date = now.toISOString().slice(0, 10)
  return `shipping-${safePrefix}-${environment}-${date}.csv`
}

/**
 * Best-effort rollback for a batch whose follow-up inserts hit a unique guard.
 * Only the dedicated shipping tables are touched; public.orders is never
 * written, read directly, or deleted from.
 */
async function cleanupFailedBatch(adminClient, batchId) {
  for (const [table, column] of [
    ['shipping_export_items', 'batch_id'],
    ['shipments', 'external_id'],
    ['shipping_export_batches', 'id'],
  ]) {
    try {
      await adminClient.from(table).delete().eq(column, batchId)
    } catch { /* the unique indexes remain the authoritative guard */ }
  }
}

/** Creates a carrier-specific UTF-8 BOM CSV and records the export batch. */
export async function createShippingExport({ adminClient, userClient, ctx, storeId, input }) {
  if (!isValidUuid(storeId)) throw new ShippingError('VALIDATION', 'معرّف الفرع غير صالح', 400)
  const { code, provider, environment } = validateTarget(
    input.providerCode, input.environment || 'sandbox',
  )
  const adapter = getAdapter(code)
  if (!adapter?.capabilities?.bulkTemplate || !adapter.buildBulkRows) {
    throw new ShippingError('NOT_SUPPORTED', `${provider.label} لا يملك قالب تصدير CSV`, 400)
  }

  const connection = await findConnection(adminClient, {
    tenantId: ctx.tenantId, storeId, providerCode: code, environment,
  })
  if (!connection?.enabled) {
    throw new ShippingError('VALIDATION', 'لم يُفعّل ربط شركة التوصيل لهذا الفرع', 400)
  }
  if (!['bulk', 'both'].includes(connection.mode)) {
    throw new ShippingError('VALIDATION', 'هذا الربط مضبوط على API فقط؛ اختر «تصدير بالجملة» أو «كلاهما»', 400)
  }

  const { data: candidates, error: rpcError } = await userClient.rpc(
    'engine_shipping_export_candidates',
    { p_store: storeId, p_provider_code: code },
  )
  if (rpcError) throw new ShippingError('NOT_FOUND', rpcError.message || 'تعذر قراءة الطلبات المؤهلة', 404)
  const snapshots = Array.isArray(candidates) ? candidates : []
  if (!snapshots.length) {
    throw new ShippingError(
      'NOT_FOUND',
      'لا توجد طلبات مؤكدة أو قيد التحضير للتصدير (الطلبات المشحونة أو المصدّرة مستبعدة).',
      404,
    )
  }

  // Defence in depth: the RPC already filters, but the gateway never trusts a
  // snapshot that drifted from the approved status set.
  const requests = snapshots
    .filter(snapshot => EXPORT_STATUSES.includes(snapshot.status) && snapshot.fulfillment_type === 'delivery')
    .map(snapshot => shipmentRequestFrom(snapshot, connection))
  if (!requests.length) {
    throw new ShippingError('NOT_FOUND', 'لا توجد طلبات مؤهلة للتصدير بعد التحقق من الحالة', 404)
  }

  const built = adapter.buildBulkRows({ requests, connection, environment })
  if (!built?.columns?.length || !Array.isArray(built.rows) || built.rows.length !== requests.length) {
    throw shippingError('INTERNAL', 'قالب التصدير أعاد بيانات غير مكتملة', 500)
  }

  const csv = csvText(built.columns, built.rows)
  if (!csv.startsWith('\uFEFF')) {
    throw shippingError('INTERNAL', 'ملف CSV لا يحمل UTF-8 BOM المطلوب', 500)
  }
  const fileHash = createHash('sha256').update(csv).digest('hex')
  const templateVersion = String(built.templateVersion || 'v1').slice(0, 80)
  const filters = {
    providerCode: code,
    environment,
    statuses: [...EXPORT_STATUSES],
    fulfillmentType: 'delivery',
    excludeShipped: true,
    excludeExported: true,
    templateVersion,
  }

  const { data: batch, error: batchError } = await adminClient
    .from('shipping_export_batches')
    .insert({
      tenant_id: ctx.tenantId,
      store_id: storeId,
      provider_code: code,
      template_version: templateVersion,
      filters,
      row_count: built.rows.length,
      file_hash: fileHash,
      exported_by: ctx.staffId,
    })
    .select('id, created_at')
    .single()
  if (batchError || !batch) {
    if (batchError?.code === '23505') {
      throw new ShippingError('CONFLICT', 'تم تسجيل دفعة التصدير هذه من قبل', 409)
    }
    throw shippingError('INTERNAL', `تعذر تسجيل دفعة التصدير: ${batchError?.message || 'خطأ غير معروف'}`, 500)
  }

  try {
    const now = new Date().toISOString()
    const shipmentRows = requests.map(request => ({
      tenant_id: ctx.tenantId,
      store_id: storeId,
      order_id: request.orderId,
      provider_code: code,
      environment,
      mode: 'bulk',
      external_id: batch.id,
      tracking_number: null,
      status: 'exported',
      raw_status: 'exported',
      label_url: null,
      cod_amount: Math.max(0, Math.round(Number(request.codAmount) || 0)),
      delivery_fee: Math.max(0, Math.round(Number(request.deliveryFee) || 0)),
      request_snapshot: request,
      response_snapshot: {
        batch_id: batch.id,
        template_version: templateVersion,
        file_hash: fileHash,
      },
      idempotency_key: createHash('sha256')
        .update(`${batch.id}:${request.orderId}:${code}:${environment}`)
        .digest('hex'),
      last_synced_at: null,
      last_error: null,
      created_at: now,
      updated_at: now,
    }))

    const { data: insertedShipments, error: shipmentError } = await adminClient
      .from('shipments')
      .insert(shipmentRows)
      .select('id, order_id')
    if (shipmentError || !Array.isArray(insertedShipments)) {
      if (shipmentError?.code === '23505') {
        throw new ShippingError('CONFLICT', 'أحد الطلبات مشحون أو مُصدّر بالفعل', 409)
      }
      throw shippingError('INTERNAL', `تعذر تسجيل شحنات التصدير: ${shipmentError?.message || 'خطأ غير معروف'}`, 500)
    }

    const shipmentByOrder = new Map(
      insertedShipments.map(row => [row.order_id, row.id]),
    )
    const { error: itemsError } = await adminClient
      .from('shipping_export_items')
      .insert(shipmentRows.map(row => ({
        tenant_id: ctx.tenantId,
        batch_id: batch.id,
        order_id: row.order_id,
        shipment_id: shipmentByOrder.get(row.order_id) || null,
      })))
    if (itemsError) {
      if (itemsError.code === '23505') {
        throw new ShippingError('CONFLICT', 'أحد الطلبات موجود في دفعة تصدير سابقة', 409)
      }
      throw shippingError('INTERNAL', `تعذر تسجيل عناصر الدفعة: ${itemsError.message}`, 500)
    }
  } catch (error) {
    await cleanupFailedBatch(adminClient, batch.id)
    throw error
  }

  return {
    csv,
    filename: fileName(built.filePrefix || code, environment),
    batchId: batch.id,
    rowCount: built.rows.length,
    providerCode: normalizeProviderCode(code),
    providerLabel: getProvider(code)?.label || provider.label,
    environment: isEnvironment(environment) ? environment : 'sandbox',
    templateVersion,
    fileHash,
  }
}
