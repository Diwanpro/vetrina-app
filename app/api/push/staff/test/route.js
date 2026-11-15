import { authorizeDispatch, PushAuthError } from '@/lib/push/authorize'
import { staffSubscriptions, buildOosPush } from '@/lib/push/staff'
import { sendPush, pushConfigured } from '@/lib/push/sender'
export const runtime = 'nodejs'
export async function POST(request) {
  try {
    const { storeId } = await request.json()
    const ctx = await authorizeDispatch(request, storeId)
    if (!pushConfigured()) return Response.json({ error: 'Push غير مضبوط' }, { status: 503 })
    const subscriptions = (await staffSubscriptions(storeId, ctx.tenantId)).filter(row => row.staff_id === ctx.staffId)
    let sent = 0
    for (const row of subscriptions) {
      try { await sendPush(row, buildOosPush({ id: 'test', store_id: storeId, store_name: 'اختبار المدير', product_name: 'اختبار إشعار نفاد المخزون', size: 'M', color: 'أحمر' })); sent++ } catch { /* count only accepted */ }
    }
    return Response.json({ ok: sent > 0, sent, subscribers: subscriptions.length })
  } catch (err) {
    return Response.json({ error: 'تعذر إرسال الاختبار' }, { status: err instanceof PushAuthError ? err.status : 500 })
  }
}
