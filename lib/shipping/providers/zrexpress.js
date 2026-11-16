// SERVER-ONLY: ZR Express / Procolis adapter (P4).
//
// Only this file knows the Procolis credential headers (`Token` + `X-Api-Key`),
// its parcel field names and its CSV template. The lifecycle, status mapping,
// webhook verification and bulk plumbing live in zrCommon.js.

import {
  createZrAdapter, procolisAuthHeaders, normalizePhone,
} from './zrCommon.js'

const BULK_COLUMNS = Object.freeze([
  { label: 'رقم الطلب', key: 'order_id' },
  { label: 'اسم الزبون', key: 'client' },
  { label: 'رقم الهاتف', key: 'phone' },
  { label: 'رقم الولاية', key: 'wilaya_id' },
  { label: 'الولاية', key: 'wilaya_name' },
  { label: 'ولاية الانطلاق', key: 'from_wilaya_name' },
  { label: 'البلدية', key: 'commune' },
  { label: 'العنوان', key: 'address' },
  { label: 'المبلغ عند الاستلام (دج)', key: 'cod_amount' },
  { label: 'رسوم التوصيل (دج)', key: 'delivery_fee' },
  { label: 'قائمة المنتجات', key: 'product_list' },
  { label: 'نوع التسليم', key: 'delivery_type' },
  { label: 'معرّف نقطة الاستلام', key: 'stop_desk_id' },
  { label: 'ملاحظة', key: 'note' },
])

export const zrexpressAdapter = createZrAdapter({
  code: 'zrexpress',
  label: 'ZR Express (Procolis)',
  platform: 'Procolis · token + key',
  orderField: 'order_id',
  authHeaders: procolisAuthHeaders,
  territoryPath: 'wilayas',
  signatureHeaders: Object.freeze(['X-ZR-Signature', 'X-ZRExpress-Signature', 'X-ZR-Express-Signature']),
  initialRawStatus: 'En attente',
  templateVersion: 'zrexpress-procolis-v1',
  filePrefix: 'zrexpress-procolis',

  buildPayload({
    request, toCode, toWilayaName, fromWilayaName,
    codAmount, deliveryFee, productList, phone, deliveryType,
  }) {
    return {
      order_id: String(request.orderNumber || request.orderId || ''),
      client: String(request.customerName || '').trim() || 'زبون',
      phone: normalizePhone(phone || request.customerPhone),
      wilaya_id: Number(toCode) || 0,
      wilaya_name: toWilayaName,
      from_wilaya_name: fromWilayaName,
      commune: String(request.commune || '').slice(0, 120),
      address: String(request.address || request.commune || '—').slice(0, 200),
      cod_amount: codAmount,
      delivery_fee: deliveryFee,
      product_list: productList,
      delivery_type: deliveryType,
      stop_desk_id: deliveryType === 'stopdesk' ? String(request.stopDeskId || '') : '',
      note: String(request.note || '').slice(0, 250),
    }
  },

  bulkColumns: BULK_COLUMNS,
  bulkRow: payload => ({
    order_id: payload.order_id,
    client: payload.client,
    phone: payload.phone,
    wilaya_id: payload.wilaya_id,
    wilaya_name: payload.wilaya_name,
    from_wilaya_name: payload.from_wilaya_name,
    commune: payload.commune,
    address: payload.address,
    cod_amount: payload.cod_amount,
    delivery_fee: payload.delivery_fee,
    product_list: payload.product_list,
    delivery_type: payload.delivery_type,
    stop_desk_id: payload.stop_desk_id,
    note: payload.note,
  }),
})

export const {
  mapStatus, shipmentStatusFrom, authHeaders, buildShipmentPayload, buildBulkRows,
} = zrexpressAdapter
