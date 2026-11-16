import { authorizeDispatch, PushAuthError } from '@/lib/push/authorize'
import { staffSubscriptions, buildOosPush } from '@/lib/push/staff'
import { adminClient } from '@/lib/push/store'
import { randomUUID } from 'node:crypto'
import { sendPush, pushConfigured, isExpiredSubscription } from '@/lib/push/sender'
export const runtime = 'nodejs'
export async function POST(request) {
  try {
    const { storeId, subscription } = await request.json()
    const ctx = await authorizeDispatch(request, storeId)
    if (!pushConfigured()) return Response.json({ error: 'Push غير مضبوط' }, { status: 503 })
    if (!subscription?.endpoint) return Response.json({ error: 'لا يوجد اشتراك على هذا الجهاز. أعد تسجيل الإشعارات.' }, { status: 400 })
    const subscriptions = (await staffSubscriptions(storeId, ctx.tenantId)).filter(row => row.staff_id === ctx.staffId && row.endpoint === subscription.endpoint)
    if (!subscriptions.length) return Response.json({ error: 'اشتراك هذا الجهاز غير محفوظ لهذا الحساب والفرع. أعد التسجيل.' }, { status: 409 })
    if (subscriptions.some(row => row.p256dh !== subscription.keys?.p256dh || row.auth !== subscription.keys?.auth)) return Response.json({ error: 'مفاتيح الاشتراك لا تطابق هذا الجهاز. أعد التسجيل.' }, { status: 409 })
    let sent = 0
    const failures = []
    for (const row of subscriptions) {
      try { await sendPush(row, buildOosPush({ id: `test-${randomUUID()}`, store_id: storeId, store_name: 'اختبار المدير', product_name: 'اختبار إشعار نفاد المخزون', size: 'M', color: 'أحمر' })); sent++ } catch (err) {
        const expired = isExpiredSubscription(err)
        if (expired) await adminClient().from('staff_push_subscriptions').delete().eq('id', row.id)
        failures.push({ status: Number(err.statusCode) || null, reason: expired ? 'انتهى اشتراك هذا الجهاز؛ أعد التسجيل' : 'رفض مزود Push الإرسال أو تعذر الاتصال به' })
      }
    }
    return Response.json({ ok: sent > 0, sent, subscribers: subscriptions.length, failures, deliveryConfirmed: false })
  } catch (err) {
    return Response.json({ error: 'تعذر إرسال الاختبار' }, { status: err instanceof PushAuthError ? err.status : 500 })
  }
}
