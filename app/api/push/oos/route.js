// Called by pg_net after COMMIT, never by an open dashboard or Realtime client.
// Per-event 256-bit capability is validated by a service-only atomic claim RPC.
import { adminClient } from '@/lib/push/store'
import { staffSubscriptions, buildOosPush } from '@/lib/push/staff'
import { sendPush, pushConfigured, isExpiredSubscription } from '@/lib/push/sender'
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60
export async function POST(request) {
  try {
    const { id, token } = await request.json()
    if (!/^[0-9a-f-]{36}$/i.test(String(id || '')) || !/^[0-9a-f]{64}$/i.test(String(token || ''))) return Response.json({ ok: false }, { status: 401 })
    if (!pushConfigured()) return Response.json({ ok: false }, { status: 503 })
    const client = adminClient()
    const claim = await client.rpc('claim_oos_push', { p_id: id, p_token: token })
    if (claim.error) throw claim.error
    if (!claim.data) return Response.json({ ok: false }, { status: 409 })
    const event = claim.data
    const subscriptions = await staffSubscriptions(event.store_id, event.tenant_id)
    let sent = 0, failed = 0
    for (const subscription of subscriptions) {
      // Revalidate the recipient at dispatch time, not merely at opt-in time.
      try {
        await sendPush(subscription, buildOosPush(event)); sent++
      } catch (err) {
        if (isExpiredSubscription(err)) {
          const removed = await client.from('staff_push_subscriptions').delete().eq('id', subscription.id)
          if (removed.error) failed++
        } else failed++
      }
    }
    const result = await client.from('oos_push_outbox').update({
      delivered_at: failed ? null : new Date().toISOString(),
      locked_until: null, sent_count: sent, failed_count: failed,
    }).eq('id', event.id)
    if (result.error) throw result.error
    return Response.json({ ok: failed === 0, sent, failed })
  } catch {
    // Do not log tokens, endpoints or subscription keys. Lease expires for retry.
    return Response.json({ ok: false }, { status: 500 })
  }
}
