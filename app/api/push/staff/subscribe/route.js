import { authorizeDispatch, PushAuthError } from '@/lib/push/authorize'
import { normalizeSubscription } from '@/lib/push/subscription'
import { validStaffEndpoint } from '@/lib/push/staff'
import { adminClient } from '@/lib/push/store'
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export async function POST(request) {
  try {
    const body = await request.json()
    const ctx = await authorizeDispatch(request, body.storeId)
    const sub = normalizeSubscription(body.subscription)
    if (!validStaffEndpoint(sub.endpoint)) return Response.json({ error: 'خدمة Push غير معروفة' }, { status: 400 })
    const client = adminClient()
    const previous = await client.from('staff_push_subscriptions').delete().eq('endpoint', sub.endpoint).neq('staff_id', ctx.staffId)
    if (previous.error) throw previous.error
    // A device cannot retain another logged-in account's staff binding.
    const { error } = await client.from('staff_push_subscriptions').upsert({
      staff_id: ctx.staffId, tenant_id: ctx.tenantId, store_id: body.storeId,
      ...sub, updated_at: new Date().toISOString(),
    }, { onConflict: 'endpoint,store_id' })
    if (error) throw error
    return Response.json({ ok: true }, { headers: { 'Cache-Control': 'no-store' } })
  } catch (err) {
    return Response.json({ ok: false, error: err instanceof PushAuthError ? err.message : 'تعذر حفظ اشتراك المدير' }, { status: err instanceof PushAuthError ? err.status : 400 })
  }
}
export async function DELETE(request) {
  try {
    const body = await request.json()
    const ctx = await authorizeDispatch(request, body.storeId)
    const { error } = await adminClient().from('staff_push_subscriptions').delete().eq('staff_id', ctx.staffId).eq('store_id', body.storeId).eq('endpoint', String(body.endpoint || ''))
    if (error) throw error
    return Response.json({ ok: true })
  } catch (err) {
    return Response.json({ ok: false, error: 'تعذر إيقاف الاشتراك' }, { status: err instanceof PushAuthError ? err.status : 400 })
  }
}
