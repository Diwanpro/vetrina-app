import { authorize, testConnection } from '@/lib/shipping/index'
import { reply, readBody, guarded, badRequest } from '@/lib/shipping/response'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * P3 connection test. With an adapter (Yalidine) it calls the real/mocked
 * testConnection; without one it falls back to the P2 local probe. If the
 * caller omits `credentials`, the gateway decrypts the saved keys.
 */
export async function POST(request) {
  return guarded(async () => {
    const body = await readBody(request)
    if (!body) return badRequest()
    const { adminClient, ctx } = await authorize(request, body.storeId)
    const result = await testConnection({ adminClient, ctx, storeId: body.storeId, input: body })
    return reply({ result })
  })
}
