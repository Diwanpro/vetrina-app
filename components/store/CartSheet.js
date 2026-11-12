'use client'

import { useEffect, useMemo, useState } from 'react'
import Sheet from './Sheet'
import CustomSelect from '@/components/ui/CustomSelect'
import { supabase } from '@/lib/supabase'
import { WILAYAS } from '@/lib/wilayas'
import { normalizeDeliveryRates, deliveryFeeFor, wilayaCodeOf } from '@/lib/delivery'
import {
  formatMoney, isValidPhone, cartTotal, orderMessage, whatsappLink,
} from '@/lib/storefront'

const fieldClass =
  'w-full rounded-xl border border-white/10 bg-white/[0.04] px-4 py-3 text-sm text-neutral-100 placeholder:text-neutral-500 focus:border-gold/60 focus:outline-none focus:ring-1 focus:ring-gold/30'

/**
 * Cart and checkout in one sheet: the list stays on screen so the customer can
 * fix a quantity without losing the form they just typed.
 */
export default function CartSheet({
  open, onClose, store, cart, priced, showPrices,
  onQty, onRemove, onConfirmed,
}) {
  // {"16": 400} from the store settings, normalised so that {"9": 400},
  // {"016": "400"} or {"البليدة": 400} all resolve too.
  const rateTable = useMemo(
    () => normalizeDeliveryRates(store?.delivery_rates),
    [store?.delivery_rates],
  )

  const [name, setName] = useState('')
  const [phone, setPhone] = useState('')
  const [wilaya, setWilaya] = useState('')
  const [commune, setCommune] = useState('')
  const [address, setAddress] = useState('')
  const [note, setNote] = useState('')
  const [fulfillment, setFulfillment] = useState('delivery')
  const [deliveryFee, setDeliveryFee] = useState(0)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [touched, setTouched] = useState(false)

  const total = useMemo(() => cartTotal(priced), [priced])
  const discount = useMemo(() => (priced || []).reduce((sum, item) => sum + Number(item.discount || 0), 0), [priced])
  const count = (cart || []).reduce((sum, item) => sum + item.qty, 0)
  // Selecting a wilaya looks its price up in stores.delivery_rates straight
  // away, so the fee and the total move together with the dropdown.
  function chooseWilaya(value) {
    setWilaya(value)
    setDeliveryFee(fulfillment === 'delivery' ? (deliveryFeeFor(rateTable, value) ?? 0) : 0)
  }

  // The store (and therefore the rate table) can arrive a tick after the sheet
  // mounts, so the fee is re-resolved whenever the table or the choice changes.
  useEffect(() => {
    const fee = fulfillment === 'delivery' && wilaya ? deliveryFeeFor(rateTable, wilaya) : null
    setDeliveryFee(fee ?? 0)
  }, [rateTable, wilaya, fulfillment])

  // The server recomputes this from stores.delivery_rates and rejects a
  // mismatch; the number here is only what the customer is shown.
  const appliedFee = fulfillment === 'delivery' ? deliveryFee : 0
  const grandTotal = total + appliedFee
  const wilayaName = WILAYAS.find(entry => entry.code === wilaya)?.name || ''
  // No price for this wilaya is not a dead end: the courier is paid on arrival,
  // so the order still goes through, with no delivery fee and a flag on it.
  const feeOnArrival = fulfillment === 'delivery' && Boolean(wilaya)
    && deliveryFeeFor(rateTable, wilaya) == null

  const nameError = name.trim().length < 2 ? 'أدخل اسمك الكامل' : ''
  const phoneError = !phone ? 'رقم الهاتف مطلوب' : (!isValidPhone(phone) ? 'رقم غير صالح (مثال: 0555123456)' : '')
  const wilayaError = fulfillment === 'delivery' && !wilaya ? 'اختر الولاية' : ''
  const invalid = Boolean(nameError || phoneError || wilayaError)

  async function confirm() {
    setTouched(true)
    if (invalid || busy || !cart.length) return
    setBusy(true)
    setError('')
    try {
      const { data: token, error: rpcError } = await supabase.rpc('create_order', {
        p_store_id: store.store_id,
        p_customer: {
          name: name.trim(),
          phone,
          fulfillment_type: fulfillment,
          wilaya_code: fulfillment === 'delivery' ? wilaya : null,
          commune: commune.trim() || null,
          address: address.trim() || null,
          note: note.trim() || null,
          // The server derives this from the rate table too; sending it keeps
          // the order readable even for a client that is behind.
          delivery_fee_on_arrival: feeOnArrival,
        },
        // The server prices the lines; only the variant and quantity are ours.
        p_items: cart.map(item => ({ variant_id: item.variantId, qty: item.qty })),
        p_source: 'web',
        // Both are re-checked against the rate table inside create_order.
        p_wilaya: fulfillment === 'delivery' ? (wilayaCodeOf(wilaya) || wilaya) : null,
        p_delivery_fee: appliedFee,
      })
      if (rpcError) throw rpcError
      if (!token) throw new Error('لم يعد الطلب رقماً صالحاً، حاول مرة أخرى')

      // The token is the customer's key; the order number is what they quote.
      const { data: order } = await supabase.rpc('get_order_by_token', { p_token: token })
      onConfirmed({ token, orderNumber: order?.order_number || '', total: order?.total ?? grandTotal })
    } catch (err) {
      setError(err.message || 'تعذر إرسال الطلب')
    } finally {
      setBusy(false)
    }
  }

  function sendOnWhatsapp() {
    const message = orderMessage({
      storeName: store.name,
      cart: priced,
      total,
      deliveryFee: appliedFee,
      feeOnArrival,
      customer: { name, phone, fulfillment },
    })
    window.open(whatsappLink(store.phone, message), '_blank', 'noopener')
  }

  return (
    <Sheet open={open} onClose={onClose} labelledBy="cart-title" full>
      <div className="flex items-center justify-between px-5 pb-3 pt-1">
        <h2 id="cart-title" className="text-lg font-bold text-neutral-50">
          سلة الطلبات {count > 0 && <span className="text-sm font-normal text-neutral-400">({count} قطعة)</span>}
        </h2>
        <button type="button" onClick={onClose} aria-label="إغلاق السلة" className="h-10 w-10 rounded-full border border-white/10 text-neutral-300">
          ✕
        </button>
      </div>

      <div className="sf-rail flex-1 overflow-y-auto px-5">
        {!cart.length ? (
          <div className="flex flex-col items-center justify-center py-16 text-center">
            <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-full border border-white/10 bg-white/5 text-2xl">🛍️</div>
            <p className="text-neutral-300">سلتك فارغة بعد</p>
            <p className="mt-1 text-sm text-neutral-500">اختر قطعة من المتجر لتظهر هنا</p>
          </div>
        ) : (
          <ul className="space-y-2">
            {priced.map(item => (
              <li key={item.variantId} className="flex gap-3 rounded-2xl border border-white/10 bg-white/[0.03] p-3">
                <div className="h-16 w-14 shrink-0 overflow-hidden rounded-xl bg-[#0d0d0d]">
                  {item.image
                    ? <img src={item.image} alt="" className="h-full w-full object-cover" />
                    : <div className="flex h-full items-center justify-center text-white/10">▦</div>}
                </div>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-neutral-100">{item.productName}</p>
                  <p className="mt-0.5 text-[11px] text-neutral-500">
                    {[item.size, item.color].filter(Boolean).join(' · ') || 'مقاس موحّد'}
                  </p>
                  <div className="mt-2 flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        aria-label="إنقاص"
                        onClick={() => onQty(item.variantId, -1)}
                        className="h-9 w-9 rounded-lg border border-white/10 bg-white/5 text-base text-neutral-200"
                      >
                        −
                      </button>
                      <span className="min-w-5 text-center text-sm font-bold text-neutral-100">{item.qty}</span>
                      <button
                        type="button"
                        aria-label="زيادة"
                        disabled={item.qty >= item.max}
                        onClick={() => onQty(item.variantId, 1)}
                        className="h-9 w-9 rounded-lg border border-white/10 bg-white/5 text-base text-neutral-200 disabled:opacity-30"
                      >
                        +
                      </button>
                    </div>
                    <div className="text-end">
                      {showPrices && (
                        <p className="text-sm font-bold text-gold">{formatMoney(item.subtotal)}</p>
                      )}
                      {item.discount > 0 && (
                        <p className="text-[10px] text-emerald-400/80">وفّرت {formatMoney(item.discount)}</p>
                      )}
                    </div>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => onRemove(item.variantId)}
                  aria-label={`إزالة ${item.productName}`}
                  className="self-start text-xs text-neutral-500 hover:text-red-300"
                >
                  إزالة
                </button>
              </li>
            ))}
          </ul>
        )}

        {cart.length > 0 && (
          <div className="mt-5 space-y-4 pb-4">
            <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-4">
              <p className="mb-3 text-sm font-medium text-neutral-200">بيانات المستلم</p>
              <div className="space-y-3">
                <div>
                  <input
                    value={name}
                    onChange={event => setName(event.target.value)}
                    onBlur={() => setTouched(true)}
                    placeholder="الاسم الكامل *"
                    autoComplete="name"
                    className={fieldClass}
                    aria-invalid={touched && Boolean(nameError)}
                  />
                  {touched && nameError && <p className="mt-1 text-[11px] text-red-300">{nameError}</p>}
                </div>
                <div>
                  <input
                    value={phone}
                    onChange={event => setPhone(event.target.value)}
                    onBlur={() => setTouched(true)}
                    placeholder="رقم الهاتف * (05/06/07)"
                    inputMode="tel"
                    autoComplete="tel"
                    dir="ltr"
                    className={`${fieldClass} text-start`}
                    aria-invalid={touched && Boolean(phoneError)}
                  />
                  {touched && phoneError && <p className="mt-1 text-[11px] text-red-300">{phoneError}</p>}
                </div>
                <div>
                  <CustomSelect
                    value={wilaya}
                    onChange={chooseWilaya}
                    options={[
                      {
                        label: fulfillment === 'delivery' ? 'الولاية *' : 'الولاية (اختياري)',
                        value: '',
                      },
                      ...WILAYAS.map(entry => ({
                        label: `${entry.code} — ${entry.name}${rateTable[entry.code] != null ? ` · ${formatMoney(rateTable[entry.code])}` : ''}`,
                        value: entry.code,
                      })),
                    ]}
                    className={fieldClass}
                    aria-label="الولاية"
                  />
                  {touched && wilayaError && <p className="mt-1 text-[11px] text-red-300">{wilayaError}</p>}
                </div>
                <input
                  value={commune}
                  onChange={event => setCommune(event.target.value)}
                  placeholder="البلدية"
                  className={fieldClass}
                />
                <input
                  value={address}
                  onChange={event => setAddress(event.target.value)}
                  placeholder="العنوان (اختياري)"
                  className={fieldClass}
                />
                <textarea
                  value={note}
                  onChange={event => setNote(event.target.value)}
                  placeholder="ملاحظة للمتجر (اختياري)"
                  rows={2}
                  className={fieldClass}
                />
              </div>
            </div>

            <div>
              <p className="mb-2 text-sm font-medium text-neutral-200">طريقة الاستلام</p>
              <div className="grid grid-cols-2 gap-2 rounded-2xl border border-white/10 bg-white/[0.03] p-1.5">
                {[
                  { key: 'delivery', label: 'توصيل' },
                  { key: 'pickup', label: 'احجز واستلم من المحل' },
                ].map(option => (
                  <button
                    key={option.key}
                    type="button"
                    onClick={() => setFulfillment(option.key)}
                    className={`min-h-11 rounded-xl px-2 text-xs font-medium transition ${
                      fulfillment === option.key ? 'bg-gold text-[#121212]' : 'text-neutral-300'
                    }`}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
            </div>

            {feeOnArrival && (
              <div
                role="status"
                className="flex gap-2 rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-2.5 text-[11px] leading-relaxed text-amber-200"
              >
                <span aria-hidden="true" className="text-sm leading-none">🛵</span>
                <span>رسوم التوصيل غير محددة مسبقاً. سيتم الدفع لمكتب التوصيل عند الاستلام.</span>
              </div>
            )}

            <div className="flex items-center justify-between rounded-2xl border border-emerald-500/20 bg-emerald-500/5 px-4 py-3">
              <div>
                <p className="text-sm font-medium text-emerald-300">الدفع عند الاستلام</p>
                <p className="mt-0.5 text-[11px] text-neutral-500">تدفع نقداً عند تسليم الطلب</p>
              </div>
              <span className="text-xl">💵</span>
            </div>
          </div>
        )}
      </div>

      {cart.length > 0 && (
        <div className="shrink-0 space-y-3 border-t border-white/10 bg-[#101010]/90 p-4 pb-[max(1rem,env(safe-area-inset-bottom))] backdrop-blur">
          {error && <p role="alert" className="rounded-xl border border-red-500/30 bg-red-950/40 px-3 py-2 text-xs text-red-200">{error}</p>}
          <div className="space-y-1 text-sm">
            {showPrices && (
              <>
                <div className="flex justify-between text-neutral-400">
                  <span>المجموع</span><span>{formatMoney(total + discount)}</span>
                </div>
                {discount > 0 && (
                  <div className="flex justify-between text-emerald-400">
                    <span>خصم العروض</span><span>− {formatMoney(discount)}</span>
                  </div>
                )}
              </>
            )}
            {fulfillment === 'delivery' && (
              <div className="flex justify-between text-neutral-400">
                <span>سعر التوصيل{wilayaName ? ` — ${wilayaName}` : ''}</span>
                <span className={deliveryFee > 0 ? 'font-medium text-neutral-100' : ''}>
                  {!wilaya ? 'اختر الولاية' : (deliveryFee > 0 ? formatMoney(deliveryFee) : 'يُدفع عند الاستلام')}
                </span>
              </div>
            )}
            {showPrices && (
              <div className="flex justify-between border-t border-white/10 pt-1 text-base font-bold text-gold">
                <span>الإجمالي</span><span>{formatMoney(grandTotal)}</span>
              </div>
            )}
          </div>

          <button
            type="button"
            onClick={confirm}
            disabled={busy}
            className="flex min-h-14 w-full items-center justify-center rounded-2xl bg-gradient-to-l from-[#E8C55A] to-gold font-bold text-[#121212] shadow-[0_10px_30px_rgba(212,175,55,0.25)] active:scale-[0.98] disabled:opacity-60"
          >
            {busy ? 'جارٍ إرسال الطلب…' : 'تأكيد الطلب'}
          </button>
          <button
            type="button"
            onClick={sendOnWhatsapp}
            className="flex min-h-12 w-full items-center justify-center gap-2 rounded-2xl border border-emerald-500/30 bg-emerald-500/10 text-sm font-medium text-emerald-300 active:scale-[0.98]"
          >
            <svg viewBox="0 0 24 24" className="h-5 w-5" fill="currentColor" aria-hidden="true">
              <path d="M12 2a10 10 0 0 0-8.6 15L2 22l5.2-1.4A10 10 0 1 0 12 2Zm5.1 14c-.2.6-1.2 1.1-1.7 1.2-.5 0-1 .1-1.7-.1a12 12 0 0 1-5.6-4.9c-.4-.7-.8-1.5-.8-2.3 0-.8.4-1.2.6-1.4.2-.2.4-.3.7-.3h.5c.2 0 .4 0 .5.4l.7 1.6c0 .2 0 .3-.1.4l-.3.4-.3.3c-.1.1-.2.3-.1.5a8 8 0 0 0 3.4 2.9c.2.1.4.1.5-.1l.6-.7c.1-.2.3-.2.5-.1l1.5.7c.2.1.4.2.4.3.1.2.1.6 0 .9Z" />
            </svg>
            اطلب عبر واتساب
          </button>
        </div>
      )}
    </Sheet>
  )
}
