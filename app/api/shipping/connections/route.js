import { authorize, listConnections, saveConnection, disableConnection } from '@/lib/shipping/index'
import { reply, readBody, guarded, badRequest } from '@/lib/shipping/response'

// node:crypto (AES-256-GCM) requires the Node.js runtime, not the Edge runtime.
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** Masked connections for one branch, through engine_list_shipping_connections. */
export async function GET(request) {
  return guarded(async () => {
    const storeId = request.nextUrl.searchParams.get('storeId')
    const { userClient } = await authorize(request, storeId)
    return reply({ connections: await listConnections(userClient, storeId) })
  })
}

/** Create/update one connection. `credentials` is optional when keys are saved. */
export async function POST(request) {
  return guarded(async () => {
    const body = await readBody(request)
    if (!body) return badRequest()
    const { adminClient, ctx } = await authorize(request, body.storeId)
    const connection = await saveConnection({ adminClient, ctx, storeId: body.storeId, input: body })
    return reply({ connection })
  })
}

/** Soft disable (keeps the audit row, clears the stored secret). */
export async function DELETE(request) {
  return guarded(async () => {
    const body = await readBody(request)
    if (!body) return badRequest()
    const { adminClient, ctx } = await authorize(request, body.storeId)
    await disableConnection({ adminClient, ctx, storeId: body.storeId, input: body })
    return reply({ ok: true })
  })
}
