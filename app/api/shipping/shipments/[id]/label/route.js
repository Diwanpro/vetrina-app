import { authorize, getShipmentLabel } from '@/lib/shipping/index'
import { reply, guarded } from '@/lib/shipping/response'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** Printable bordereau URL (mock data: URL is fully offline). */
export async function GET(request, { params }) {
  return guarded(async () => {
    const { id } = await params
    const storeId = request.nextUrl.searchParams.get('storeId')
    const { adminClient, ctx } = await authorize(request, storeId)
    const result = await getShipmentLabel({
      adminClient, ctx, storeId, shipmentId: id,
    })
    return reply(result)
  })
}
