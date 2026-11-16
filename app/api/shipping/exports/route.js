import { authorize } from '@/lib/shipping/index'
import { createShippingExport } from '@/lib/shipping/export'
import { reply, readBody, guarded, badRequest } from '@/lib/shipping/response'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * P4 bulk CSV export. The gateway returns the BOM-prefixed CSV text plus its
 * batch metadata; the browser turns it into a download. Eligible orders are
 * read through engine_shipping_export_candidates and recorded only in the
 * dedicated shipping tables — public.orders is never written.
 */
export async function POST(request) {
  return guarded(async () => {
    const body = await readBody(request)
    if (!body) return badRequest()
    const { adminClient, userClient, ctx } = await authorize(request, body.storeId)
    const result = await createShippingExport({
      adminClient, userClient, ctx, storeId: body.storeId, input: body,
    })
    return reply(result, 201)
  })
}
