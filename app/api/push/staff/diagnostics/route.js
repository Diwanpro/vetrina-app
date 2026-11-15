import { authorizeDispatch, PushAuthError } from '@/lib/push/authorize'
import { adminClient } from '@/lib/push/store'
import { pushConfigured } from '@/lib/push/config'
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export async function POST(request) {
  try {
    const body = await request.json()
    const ctx = await authorizeDispatch(request, body.storeId)
    let registered = false, keysMatch = false
    if (body.subscription?.endpoint) {
      const { data, error } = await adminClient().from('staff_push_subscriptions')
        .select('p256dh, auth').eq('staff_id', ctx.staffId).eq('tenant_id', ctx.tenantId)
        .eq('store_id', body.storeId).eq('endpoint', String(body.subscription.endpoint).slice(0, 1000)).maybeSingle()
      if (error) throw error
      registered = Boolean(data)
      keysMatch = Boolean(data && data.p256dh === body.subscription.keys?.p256dh && data.auth === body.subscription.keys?.auth)
    }
    return Response.json({ registered, keysMatch, configured: pushConfigured() }, { headers: { 'Cache-Control': 'no-store' } })
  } catch (err) {
    return Response.json({ error: err instanceof PushAuthError ? err.message : 'تعذر التحقق من قاعدة البيانات' }, { status: err instanceof PushAuthError ? err.status : 500 })
  }
}
