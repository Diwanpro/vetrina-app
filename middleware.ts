import { NextResponse } from 'next/server'

export function middleware() {
  return NextResponse.next()
}

export const config = {
  // An empty matcher generates an invalid generic Vercel route. This
  // middleware is a no-op, so restrict it to a dedicated inert URL.
  matcher: ['/__vetrina_noop_middleware__'],
}
