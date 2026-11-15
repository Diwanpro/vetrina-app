'use client'

// P3/P4 "شحن الطلب" control. It never writes to public.orders: the click goes
// to the server gateway, which reads the order through a definer RPC and
// records the parcel in the dedicated shipments / shipment_events tables.
//
// P4: the button is itself a dark drawer menu. Options are derived from the
// ENABLED API connections of this order's branch, so Yalidine and both ZR
// platforms appear without any courier-specific branch in this component.

import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useDrawerMenu, drawerClass } from '@/components/ui/drawerMenu'

const SHIPPABLE_STATUSES = ['confirmed', 'preparing']
const ACTIVE_STATUSES = ['created', 'in_transit', 'delivered', 'returned', 'exported']

function safeLabelUrl(value) {
  const url = String(value || '').trim()
  if (/^data:image\/(svg\+xml|png|jpeg);/i.test(url)) return url
  if (/^https?:\/\//i.test(url)) return url
  return ''
}

export default function ShippingButton({
  order, shipment, busy, disabled, options = [], onShip,
}) {
  const [isOpen, setIsOpen] = useState(false)
  const [rect, setRect] = useState(null)
  const triggerRef = useRef(null)
  const menuRef = useRef(null)
  const { mounted, phase } = useDrawerMenu(isOpen)

  const shippable = order.fulfillment_type === 'delivery' && SHIPPABLE_STATUSES.includes(order.status)
  const hasOptions = Array.isArray(options) && options.length > 0

  const measure = () => {
    const node = triggerRef.current
    if (!node) return null
    const box = node.getBoundingClientRect()
    const next = { top: box.bottom + 4, left: box.left, width: Math.max(box.width, 220) }
    setRect(next)
    return next
  }

  useEffect(() => {
    if (!mounted) return
    const update = () => measure()
    update()
    window.addEventListener('resize', update)
    window.addEventListener('scroll', update, true)
    return () => {
      window.removeEventListener('resize', update)
      window.removeEventListener('scroll', update, true)
    }
  }, [mounted])

  useEffect(() => {
    if (!isOpen) return
    const onPointerDown = event => {
      if (triggerRef.current?.contains(event.target)) return
      if (menuRef.current?.contains(event.target)) return
      setIsOpen(false)
    }
    const onKeyDown = event => {
      if (event.key === 'Escape') setIsOpen(false)
    }
    document.addEventListener('mousedown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [isOpen])

  if (!shippable) return null

  if (shipment && ACTIVE_STATUSES.includes(shipment.status)) {
    const exported = shipment.status === 'exported'
    const labelUrl = safeLabelUrl(shipment.label_url)
    const isData = labelUrl.startsWith('data:')
    return (
      <div className="flex min-h-9 flex-wrap items-center gap-2 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-1.5 text-xs text-emerald-200">
        <span>{exported ? 'تم التصدير' : 'تم الشحن'}</span>
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

  const isDisabled = busy || disabled || !hasOptions

  function toggle() {
    if (isDisabled) return
    setIsOpen(open => {
      if (!open) measure()
      return !open
    })
  }

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        disabled={isDisabled}
        title={!hasOptions ? 'اضبط رابط شركة التوصيل من الإعدادات أولاً' : undefined}
        aria-haspopup="listbox"
        aria-expanded={isOpen}
        aria-label={`خيارات شحن الطلب ${order.order_number}`}
        onClick={toggle}
        className="flex min-h-9 items-center gap-2 rounded-lg border border-gold/40 bg-gold/10 px-3 text-xs font-medium text-gold transition hover:bg-gold/20 disabled:cursor-not-allowed disabled:opacity-50"
      >
        <span>{busy ? 'جاري الشحن...' : 'شحن الطلب'}</span>
        <span aria-hidden="true" className={`transition-transform duration-200 ${isOpen ? 'rotate-180' : ''}`}>▼</span>
      </button>

      {mounted && hasOptions && rect && typeof document !== 'undefined' && createPortal(
        <ul
          ref={menuRef}
          role="listbox"
          aria-label="اختر شركة التوصيل"
          style={{ position: 'fixed', top: rect.top, left: rect.left, width: rect.width, zIndex: 80 }}
          className={`${drawerClass(phase)} max-h-72 overflow-y-auto rounded-lg border border-gold/20 bg-[#1A1A1A] py-1 shadow-xl`}
        >
          {options.map(option => (
            <li key={option.value}>
              <button
                type="button"
                role="option"
                aria-selected="false"
                onClick={event => {
                  event.stopPropagation()
                  setIsOpen(false)
                  onShip(order, option.value)
                }}
                className="w-full px-3 py-2 text-start text-sm text-neutral-200 transition-colors hover:bg-gold/10 hover:text-gold"
              >
                <span className="block truncate">{option.label}</span>
                {option.description && (
                  <span className="mt-0.5 block truncate text-[11px] text-neutral-500">{option.description}</span>
                )}
              </button>
            </li>
          ))}
        </ul>,
        document.body
      )}
    </>
  )
}
