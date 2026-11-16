// SERVER-ONLY canonical ShipmentRequest builder.
//
// Both the API shipping gateway (P3) and the CSV bulk export gateway (P4)
// start from the same order snapshot. Carrier-specific payloads live in the
// provider adapters; this helper only normalises the app's own order shape.

/** Read-only order snapshot + connection defaults -> canonical request. */
export function shipmentRequestFrom(snapshot, connection) {
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
