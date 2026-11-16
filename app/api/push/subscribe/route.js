// Customer subscribes to ONE branch's push notifications (v3.1).

import { normalizeSlug, normalizeSubscription } from '@/lib/push/subscription'
import { saveSubscription } from '@/lib/push/store'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(request) {
  try {
    const body = await request.json()
    const slug = normalizeSlug(body?.slug)
    if (!slug) return Response.json({ ok: false, error: 'رابط المتجر مطلوب' }, { status: 400 })
    const subscription = normalizeSubscription(body?.subscription)
    const result = await saveSubscription(slug, subscription, request.headers.get('user-agent'))
    return Response.json(
      { ok: true, storeId: result.storeId, storeName: result.storeName },
      { headers: { 'Cache-Control': 'no-store' } },
    )
  } catch (err) {
    const message = err.message || 'تعذر تسجيل الاشتراك'
    const configError = /غير مكتملة|غير موجود/.test(message)
    return Response.json({ ok: false, error: message }, { status: configError ? 503 : 400 })
  }
}
