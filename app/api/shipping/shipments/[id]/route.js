import { authorize, cancelShipment } from '@/lib/shipping/index'
import { reply, readBody, guarded, badRequest } from '@/lib/shipping/response'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** Cancel a shipment (soft: keeps the audit row, frees the partial unique index). */
export async function DELETE(request, { params }) {
  return guarded(async () => {
    const { id } = await params
    const body = await readBody(request)
    if (!body) return badRequest()
    const { adminClient, ctx } = await authorize(request, body.storeId)
    const result = await cancelShipment({
      adminClient, ctx, storeId: body.storeId, shipmentId: id,
    })
    return reply(result)
  })
}
