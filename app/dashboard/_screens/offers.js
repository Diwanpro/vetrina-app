'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Notice, fieldClass, primaryClass, secondaryClass } from '@/components/dashboard/EngineUI'
import CustomSelect from '@/components/ui/CustomSelect'
import { fetchAllRows } from '@/lib/cash'
import { getAppContext, formatDzd } from '@/lib/app-context'
import { priceLine } from '@/lib/offers'
import { supabase } from '@/lib/supabase'

const KINDS = [
  { label: 'خصم بالنسبة المئوية', value: 'percent' },
  { label: 'عرض حزمة (كمية بسعر إجمالي)', value: 'bundle' },
]

export default function OffersPage() {
  const [ctx, setCtx] = useState(null)
  const [products, setProducts] = useState([])
  const [offers, setOffers] = useState([])
  const [productId, setProductId] = useState('')
  const [variantId, setVariantId] = useState('')
  const [kind, setKind] = useState('percent')
  const [percent, setPercent] = useState('')
  const [requiredQty, setRequiredQty] = useState('2')
  const [offerPrice, setOfferPrice] = useState('')
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const context = await getAppContext()
      setCtx(context)
      const rows = await fetchAllRows(supabase.from('products')
        .select('id, name, base_price, product_variants(id, color, size, cost_price_avg)')
        .eq('tenant_id', context.tenantId).eq('is_active', true).order('name'))
      setProducts(rows)
      const { data, error: rpcError } = await supabase.rpc('engine_offers', { p_tenant: context.tenantId })
      if (rpcError) throw rpcError
      setOffers(data || [])
    } catch (err) { setError(err.message) } finally { setLoading(false) }
  }, [])

  useEffect(() => { load() }, [load])

  const product = products.find(row => row.id === productId)
  const variants = product?.product_variants || []
  const variant = variants.find(row => row.id === variantId)

  // Owner-facing preview, including whether the offer loses money.
  const preview = useMemo(() => {
    if (!variant || !product) return null
    const unitPrice = Number(product.base_price || 0)
    const candidate = kind === 'percent'
      ? { id: 'preview', kind: 'percent', discount_percentage: Number(percent || 0) }
      : { id: 'preview', kind: 'bundle', required_qty: Number(requiredQty || 0), offer_price: Number(offerPrice || 0) }
    const qty = kind === 'percent' ? 1 : Number(requiredQty || 0)
    const priced = priceLine({ qty, unitPrice, offer: candidate })
    if (!priced) return null
    const cost = Number(variant.cost_price_avg || 0)
    const perUnit = qty > 0 ? Math.round(priced.subtotal / qty) : 0
    return { subtotal: priced.subtotal, perUnit, cost, loss: perUnit < cost, qty }
  }, [variant, product, kind, percent, requiredQty, offerPrice])

  async function save(event) {
    event.preventDefault()
    if (busy) return
    setError(''); setSuccess('')
    if (!variantId) { setError('اختر المقاس'); return }
    setBusy(true)
    try {
      const { error: rpcError } = await supabase.rpc('engine_save_offer', {
        p_tenant: ctx.tenantId,
        p_product: productId,
        p_variant: variantId,
        p_kind: kind,
        p_discount: kind === 'percent' ? Number(percent) : null,
        p_required_qty: kind === 'bundle' ? Number(requiredQty) : null,
        p_offer_price: kind === 'bundle' ? Number(offerPrice) : null,
        p_name: name,
      })
      if (rpcError) throw rpcError
      setSuccess('تم حفظ العرض')
      setPercent(''); setOfferPrice(''); setName('')
      await load()
    } catch (err) { setError(err.message || 'تعذر حفظ العرض') } finally { setBusy(false) }
  }

  async function toggle(offer) {
    setError('')
    try {
      const { error: rpcError } = await supabase.rpc('engine_set_offer_active', {
        p_tenant: ctx.tenantId, p_offer: offer.id, p_active: !offer.is_active,
      })
      if (rpcError) throw rpcError
      await load()
    } catch (err) { setError(err.message) }
  }

  async function remove(offer) {
    setError('')
    try {
      const { error: rpcError } = await supabase.rpc('engine_delete_offer', {
        p_tenant: ctx.tenantId, p_offer: offer.id,
      })
      if (rpcError) throw rpcError
      await load()
    } catch (err) { setError(err.message) }
  }

  function variantLabel(offer) {
    const owner = products.find(row => row.id === offer.product_id)
    const found = owner?.product_variants?.find(row => row.id === offer.variant_id)
    return `${owner?.name || '—'} · ${found?.color || 'بدون لون'} / ${found?.size || 'موحّد'}`
  }

  return (
    <div className="mx-auto max-w-4xl space-y-5">
      <h1 className="text-xl text-neutral-100">العروض الترويجية</h1>
      <Notice error={error} success={success} />

      <form onSubmit={save} className="space-y-4 rounded-2xl border border-gold/20 bg-card p-5">
        <h2 className="text-gold">عرض جديد</h2>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="block text-sm text-neutral-300">
            <span className="mb-1 block">المنتج</span>
            <CustomSelect
              value={productId}
              onChange={next => { setProductId(next); setVariantId('') }}
              options={[{ label: 'اختر المنتج', value: '' }, ...products.map(row => ({ label: row.name, value: row.id }))]}
              className={`${fieldClass} mt-1`}
            />
          </div>
          <div className="block text-sm text-neutral-300">
            <span className="mb-1 block">المقاس / اللون</span>
            <CustomSelect
              value={variantId}
              onChange={setVariantId}
              disabled={!productId}
              options={[
                { label: productId ? 'اختر المقاس' : 'اختر المنتج أولاً', value: '' },
                ...variants.map(row => ({ label: `${row.color || 'بدون لون'} / ${row.size || 'موحّد'}`, value: row.id })),
              ]}
              className={`${fieldClass} mt-1`}
            />
          </div>
          <div className="block text-sm text-neutral-300">
            <span className="mb-1 block">نوع العرض</span>
            <CustomSelect value={kind} onChange={setKind} options={KINDS} className={`${fieldClass} mt-1`} />
          </div>
          {kind === 'percent' ? (
            <label className="block text-sm text-neutral-300">نسبة الخصم (%)
              <input inputMode="numeric" required value={percent} disabled={busy}
                onChange={event => setPercent(event.target.value.replace(/[^0-9]/g, ''))}
                className={`${fieldClass} mt-1`} placeholder="مثال: 20" />
            </label>
          ) : (
            <div className="grid grid-cols-2 gap-3">
              <label className="block text-sm text-neutral-300">الكمية
                <input inputMode="numeric" required value={requiredQty} disabled={busy}
                  onChange={event => setRequiredQty(event.target.value.replace(/[^0-9]/g, ''))}
                  className={`${fieldClass} mt-1`} placeholder="2" />
              </label>
              <label className="block text-sm text-neutral-300">السعر الإجمالي (دج)
                <input inputMode="numeric" required value={offerPrice} disabled={busy}
                  onChange={event => setOfferPrice(event.target.value.replace(/[^0-9]/g, ''))}
                  className={`${fieldClass} mt-1`} placeholder="3000" />
              </label>
            </div>
          )}
          <label className="block text-sm text-neutral-300 sm:col-span-2">اسم العرض (اختياري)
            <input value={name} disabled={busy} onChange={event => setName(event.target.value)}
              className={`${fieldClass} mt-1`} placeholder="مثال: عرض نهاية الأسبوع" />
          </label>
        </div>

        {preview && (
          <div className={`rounded-xl border p-3 text-sm ${preview.loss ? 'border-red-800/50 bg-red-950/20' : 'border-gold/20 bg-black/20'}`}>
            <p className="text-neutral-300">
              سعر البيع بعد العرض: <span className="text-gold">{formatDzd(preview.subtotal)}</span>
              {preview.qty > 1 && <span className="text-neutral-500"> · {formatDzd(preview.perUnit)} للوحدة</span>}
            </p>
            <p className="mt-1 text-xs text-neutral-500">متوسط التكلفة: {formatDzd(preview.cost)} للوحدة</p>
            {preview.loss && <p className="mt-1 text-xs text-red-300">تحذير: هذا العرض يبيع بأقل من التكلفة.</p>}
          </div>
        )}

        <button disabled={busy} className={primaryClass}>{busy ? 'جاري الحفظ...' : 'حفظ العرض'}</button>
      </form>

      <section className="rounded-2xl border border-white/10 bg-card p-5">
        <h2 className="mb-3 text-gold">العروض النشطة · {offers.length}</h2>
        {loading ? <p className="text-sm text-neutral-500">جاري التحميل...</p>
          : !offers.length ? <p className="text-sm text-neutral-500">لا توجد عروض بعد.</p>
          : <ul className="space-y-2">
            {offers.map(offer => (
              <li key={offer.id} className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-white/5 p-3">
                <div className="min-w-0">
                  <p className="text-sm text-neutral-200">{offer.name || variantLabel(offer)}</p>
                  <p className="mt-1 text-xs text-neutral-500">
                    {variantLabel(offer)} · {offer.kind === 'percent'
                      ? `${offer.discount_percentage}% خصم`
                      : `${offer.required_qty} بسعر ${formatDzd(offer.offer_price)}`}
                  </p>
                </div>
                <div className="flex gap-2">
                  <button type="button" onClick={() => toggle(offer)} className={secondaryClass}>
                    {offer.is_active ? 'إيقاف' : 'تفعيل'}
                  </button>
                  <button type="button" onClick={() => remove(offer)}
                    className="rounded-lg border border-red-800/40 px-3 py-2 text-xs text-red-300">حذف</button>
                </div>
              </li>
            ))}
          </ul>}
      </section>
    </div>
  )
}
