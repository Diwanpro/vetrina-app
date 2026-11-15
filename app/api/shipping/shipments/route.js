import { authorize, listShipments, shipOrder } from '@/lib/shipping/index'
import { reply, readBody, guarded, badRequest } from '@/lib/shipping/response'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** Shipments for one branch (masked definer RPC). */
export async function GET(request) {
  return guarded(async () => {
    const storeId = request.nextUrl.searchParams.get('storeId')
    const { userClient } = await authorize(request, storeId)
    return reply({ shipments: await listShipments(userClient, storeId) })
  })
}

/** P3: create a parcel through the Yalidine adapter and record it. */
export async function POST(request) {
  return guarded(async () => {
    const body = await readBody(request)
    if (!body) return badRequest()
    const { adminClient, userClient, ctx } = await authorize(request, body.storeId)
    const result = await shipOrder({ adminClient, userClient, ctx, storeId: body.storeId, input: body })
    return reply(result, 201)
  })
}
