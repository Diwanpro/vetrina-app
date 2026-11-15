import { NextResponse } from 'next/server'
import {
  authorize, listConnections, saveConnection, disableConnection, errorResponse,
} from '@/lib/shipping/index'

// node:crypto (AES-256-GCM) requires the Node.js runtime, not the Edge runtime.
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const NO_STORE = { 'Cache-Control': 'no-store' }

function reply(body, status = 200) {
  return NextResponse.json(body, { status, headers: NO_STORE })
}

async function readBody(request) {
  try {
    const value = await request.json()
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null
  } catch {
    return null
  }
}

/** Masked connections for one branch, through engine_list_shipping_connections. */
export async function GET(request) {
  try {
    const storeId = request.nextUrl.searchParams.get('storeId')
    const { userClient } = await authorize(request, storeId)
    const connections = await listConnections(userClient, storeId)
    return reply({ connections })
  } catch (error) {
    const result = errorResponse(error)
    return reply(result.body, result.status)
  }
}

/** Create/update one connection. `credentials` is optional when keys are saved. */
export async function POST(request) {
  try {
    const body = await readBody(request)
    if (!body) return reply({ error: 'طلب غير صالح', code: 'VALIDATION' }, 400)
    const { adminClient, ctx } = await authorize(request, body.storeId)
    const connection = await saveConnection({
      adminClient, ctx, storeId: body.storeId, input: body,
    })
    return reply({ connection })
  } catch (error) {
    const result = errorResponse(error)
    return reply(result.body, result.status)
  }
}

/** Soft disable (keeps the audit row, clears the stored secret). */
export async function DELETE(request) {
  try {
    const body = await readBody(request)
    if (!body) return reply({ error: 'طلب غير صالح', code: 'VALIDATION' }, 400)
    const { adminClient, ctx } = await authorize(request, body.storeId)
    await disableConnection({ adminClient, ctx, storeId: body.storeId, input: body })
    return reply({ ok: true })
  } catch (error) {
    const result = errorResponse(error)
    return reply(result.body, result.status)
  }
}
