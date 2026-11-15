// Public VAPID key for customer subscriptions (v3.1). No secret is returned.

import { publicVapidKey } from '@/lib/push/config'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET() {
  const publicKey = publicVapidKey()
  return Response.json(
    { enabled: Boolean(publicKey), publicKey },
    { headers: { 'Cache-Control': 'no-store' } },
  )
}
