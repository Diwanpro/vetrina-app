import { NextResponse } from 'next/server'
import { authorize, testConnection, errorResponse } from '@/lib/shipping/index'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const NO_STORE = { 'Cache-Control': 'no-store' }

function reply(body, status = 200) {
  return NextResponse.json(body, { status, headers: NO_STORE })
}

/**
 * P2 connection test. If the caller omits `credentials`, the gateway decrypts
 * the already-saved keys (AAD-bound) so "اختبار الاتصال" works after a reload.
 */
export async function POST(request) {
  try {
    let body = null
    try {
      const value = await request.json()
      if (value && typeof value === 'object' && !Array.isArray(value)) body = value
    } catch { /* handled below */ }
    if (!body) return reply({ error: 'طلب غير صالح', code: 'VALIDATION' }, 400)

    const { adminClient, ctx } = await authorize(request, body.storeId)
    const result = await testConnection({
      adminClient, ctx, storeId: body.storeId, input: body,
    })
    return reply({ result })
  } catch (error) {
    const result = errorResponse(error)
    return reply(result.body, result.status)
  }
}
