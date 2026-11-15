// Merchant dispatcher (v3.1).
//
// Called after a NEW product or promotional offer is saved. The caller's JWT is
// verified against engine_session + engine_staff; only subscribers of THAT
// branch receive the notification. public.orders is never touched.

import { authorizeDispatch, PushAuthError } from '@/lib/push/authorize'
import { normalizePushKind } from '@/lib/push/subscription'
import { buildPushMessage } from '@/lib/push/notification'
import { getStoreById, subscriptionsForStore, deleteSubscriptions } from '@/lib/push/store'
import { sendPush, isExpiredSubscription, pushConfigured } from '@/lib/push/sender'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(request) {
  try {
    const body = await request.json()
    const storeId = String(body?.storeId || '').trim()
    const kind = normalizePushKind(body?.kind)
    const name = String(body?.name || '').slice(0, 120)

    await authorizeDispatch(request, storeId)
    if (!pushConfigured()) {
      return Response.json(
        { ok: false, error: 'إشعارات الدفع غير مضبوطة على الخادم (PUSH_VAPID_CONFIG)' },
        { status: 503 },
      )
    }

    const store = await getStoreById(storeId)
    if (!store?.id) return Response.json({ ok: false, error: 'الفرع غير موجود' }, { status: 404 })

    const subscriptions = await subscriptionsForStore(storeId)
    const origin = String(process.env.NEXT_PUBLIC_SITE_URL || '').trim() || new URL(request.url).origin
    const message = buildPushMessage({
      storeName: store.name,
      storeSlug: store.slug || storeId,
      origin,
      kind,
      itemName: name,
      logoUrl: store.logo_url,
    })

    let sent = 0
    let failed = 0
    const expired = []
    await Promise.all(subscriptions.map(async subscription => {
      try {
        await sendPush(subscription, message)
        sent += 1
      } catch (err) {
        failed += 1
        if (isExpiredSubscription(err)) expired.push(subscription.id)
      }
    }))
    await deleteSubscriptions(expired)

    return Response.json({
      ok: true,
      storeName: store.name,
      storeId,
      kind,
      subscribers: subscriptions.length,
      sent,
      failed,
      pruned: expired.length,
      url: message.url,
    }, { headers: { 'Cache-Control': 'no-store' } })
  } catch (err) {
    const status = err instanceof PushAuthError ? err.status : 500
    return Response.json(
      { ok: false, error: err.message || 'تعذر إرسال الإشعارات' },
      { status },
    )
  }
}
