import { authorize, syncShipment } from '@/lib/shipping/index'
import { reply, readBody, guarded, badRequest } from '@/lib/shipping/response'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** Pull the courier status (getTracking) and append idempotent events. */
export async function POST(request, { params }) {
  return guarded(async () => {
    const { id } = await params
    const body = await readBody(request)
    if (!body) return badRequest()
    const { adminClient, ctx } = await authorize(request, body.storeId)
    const result = await syncShipment({
      adminClient, ctx, storeId: body.storeId, shipmentId: id,
    })
    return reply(result)
  })
}
