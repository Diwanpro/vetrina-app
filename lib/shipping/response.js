// SERVER-ONLY: shared Route Handler helpers. Keeps every shipping endpoint
// consistent: no-store responses, strict JSON bodies, classified errors.

import { NextResponse } from 'next/server'
import { errorResponse } from './index.js'

const NO_STORE = { 'Cache-Control': 'no-store' }

export function reply(body, status = 200) {
  return NextResponse.json(body, { status, headers: NO_STORE })
}

export async function readBody(request) {
  try {
    const value = await request.json()
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null
  } catch {
    return null
  }
}

export async function guarded(fn) {
  try {
    return await fn()
  } catch (error) {
    const result = errorResponse(error)
    return reply(result.body, result.status)
  }
}

export function badRequest(message = 'طلب غير صالح') {
  return reply({ error: message, code: 'VALIDATION' }, 400)
}
