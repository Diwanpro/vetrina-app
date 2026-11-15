'use client'

// P3 "شحن الطلب" control. It never writes to public.orders: the click goes to
// the server gateway, which reads the order through a definer RPC and records
// the parcel in the dedicated shipments / shipment_events tables.

const SHIPPABLE_STATUSES = ['confirmed', 'preparing']
const ACTIVE_STATUSES = ['created', 'in_transit', 'delivered', 'returned', 'exported']

function safeLabelUrl(value) {
  const url = String(value || '').trim()
  if (/^data:image\/(svg\+xml|png|jpeg);/i.test(url)) return url
  if (/^https?:\/\//i.test(url)) return url
  return ''
}

export default function ShippingButton({ order, shipment, busy, disabled, onShip }) {
  if (order.fulfillment_type !== 'delivery' || !SHIPPABLE_STATUSES.includes(order.status)) {
    return null
  }

  if (shipment && ACTIVE_STATUSES.includes(shipment.status)) {
    const labelUrl = safeLabelUrl(shipment.label_url)
    const isData = labelUrl.startsWith('data:')
    return (
      <div className="flex min-h-9 flex-wrap items-center gap-2 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-1.5 text-xs text-emerald-200">
        <span>تم الشحن</span>
        {shipment.tracking_number && <span dir="ltr" className="font-medium tabular-nums">{shipment.tracking_number}</span>}
        {labelUrl && (
          <a
            href={labelUrl}
            {...(isData
              ? { download: `bordereau-${shipment.tracking_number || order.order_number}.svg` }
              : { target: '_blank', rel: 'noopener noreferrer' })}
            className="underline decoration-emerald-300/40 underline-offset-2 hover:text-white"
          >
            الملصق
          </a>
        )}
      </div>
    )
  }

  return (
    <button
      type="button"
      disabled={busy || disabled}
      title={disabled ? 'اضبط رابط شركة التوصيل من الإعدادات أولاً' : undefined}
      onClick={() => onShip(order)}
      className="min-h-9 rounded-lg border border-gold/40 bg-gold/10 px-3 text-xs font-medium text-gold transition hover:bg-gold/20 disabled:cursor-not-allowed disabled:opacity-50"
    >
      {busy ? 'جاري الشحن...' : 'شحن الطلب'}
    </button>
  )
}
