// SERVER-ONLY: ZR Express new-platform adapter (P4).
//
// This platform uses `X-Api-Key` + `X-Tenant` and UUID territory ids. All of
// that stays here; the gateway and OrderCard still see the same adapter
// contract as Yalidine and Procolis.

import {
  createZrAdapter, newPlatformAuthHeaders, normalizePhone, deterministicTerritoryId,
} from './zrCommon.js'

const BULK_COLUMNS = Object.freeze([
  { label: 'رقم الطلب', key: 'orderId' },
  { label: 'المستلم', key: 'recipient' },
  { label: 'رقم الهاتف', key: 'phone' },
  { label: 'معرّف المنطقة', key: 'territoryId' },
  { label: 'الولاية', key: 'wilaya' },
  { label: 'ولاية الانطلاق', key: 'fromWilaya' },
  { label: 'البلدية', key: 'commune' },
  { label: 'العنوان', key: 'address' },
  { label: 'المبلغ عند الاستلام (دج)', key: 'codAmount' },
  { label: 'رسوم التوصيل (دج)', key: 'deliveryFee' },
  { label: 'قائمة المنتجات', key: 'productList' },
  { label: 'نوع التسليم', key: 'deliveryType' },
  { label: 'معرّف نقطة الاستلام', key: 'stopDeskId' },
  { label: 'ملاحظة', key: 'note' },
])

export const zrexpressnewAdapter = createZrAdapter({
  code: 'zrexpressnew',
  label: 'ZR Express (المنصة الجديدة)',
  platform: 'zrexpress.app · apiKey + tenant',
  orderField: 'orderId',
  authHeaders: newPlatformAuthHeaders,
  territoryPath: 'territories',
  signatureHeaders: Object.freeze(['X-ZR-Signature', 'X-ZRNew-Signature', 'X-ZRExpress-Signature']),
  initialRawStatus: 'pending',
  templateVersion: 'zrexpressnew-v1',
  filePrefix: 'zrexpress-new',

  buildPayload({
    request, toCode, toWilayaName, fromWilayaName,
    codAmount, deliveryFee, productList, phone, deliveryType,
  }) {
    const commune = String(request.commune || 'Centre Ville').slice(0, 120)
    return {
      orderId: String(request.orderNumber || request.orderId || ''),
      recipient: String(request.customerName || '').trim() || 'زبون',
      phone: normalizePhone(phone || request.customerPhone),
      territoryId: deterministicTerritoryId(toCode, commune),
      wilaya: toWilayaName,
      fromWilaya: fromWilayaName,
      commune,
      address: String(request.address || commune || '—').slice(0, 200),
      codAmount,
      deliveryFee,
      productList,
      deliveryType,
      stopDeskId: deliveryType === 'stopdesk' ? String(request.stopDeskId || '') : '',
      note: String(request.note || '').slice(0, 250),
    }
  },

  bulkColumns: BULK_COLUMNS,
  bulkRow: payload => ({
    orderId: payload.orderId,
    recipient: payload.recipient,
    phone: payload.phone,
    territoryId: payload.territoryId,
    wilaya: payload.wilaya,
    fromWilaya: payload.fromWilaya,
    commune: payload.commune,
    address: payload.address,
    codAmount: payload.codAmount,
    deliveryFee: payload.deliveryFee,
    productList: payload.productList,
    deliveryType: payload.deliveryType,
    stopDeskId: payload.stopDeskId,
    note: payload.note,
  }),
})

export const {
  mapStatus, shipmentStatusFrom, authHeaders, buildShipmentPayload, buildBulkRows,
} = zrexpressnewAdapter
