// Customer stops this branch's notifications (v3.1).

import { normalizeSlug } from '@/lib/push/subscription'
import { removeSubscription } from '@/lib/push/store'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(request) {
  try {
    const body = await request.json()
    const slug = normalizeSlug(body?.slug)
    const endpoint = String(body?.endpoint || '').trim().slice(0, 1000)
    if (!slug || !endpoint) return Response.json({ ok: false, error: 'بيانات الاشتراك ناقصة' }, { status: 400 })
    const result = await removeSubscription(slug, endpoint)
    return Response.json(result, { headers: { 'Cache-Control': 'no-store' } })
  } catch (err) {
    return Response.json({ ok: false, error: err.message || 'تعذر إيقاف الاشتراك' }, { status: 400 })
  }
}
