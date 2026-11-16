import { webhookAdminClient, handleShippingWebhook } from '@/lib/shipping/index'
import { reply, guarded } from '@/lib/shipping/response'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Courier webhook. No user JWT: the HMAC signature over the EXACT raw body is
 * the only credential. Nothing is written before verification succeeds.
 */
export async function POST(request, { params }) {
  return guarded(async () => {
    const { provider } = await params
    const rawBody = await request.text()
    const headers = Object.fromEntries(request.headers.entries())
    const adminClient = webhookAdminClient()
    const result = await handleShippingWebhook({
      adminClient, providerCode: provider, rawBody, headers, env: process.env,
    })
    return reply(result)
  })
}
