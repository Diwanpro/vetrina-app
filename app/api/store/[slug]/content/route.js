import { readStorefrontContent } from '@/lib/server/storefront-content'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const empty = { banners: [], sections: [] }
const respond = (body, status) => Response.json(body, { status, headers: { 'Cache-Control': 'private, no-store' } })

export async function GET(request, { params }) {
  // This is a storefront read, not a general-purpose signing endpoint.
  if (new URL(request.url).search) return respond(empty, 400)
  try {
    const { slug } = await params
    const content = await readStorefrontContent(slug, request.signal)
    return content ? respond(content, 200) : respond(empty, 404)
  } catch {
    // Do not return/log Storage responses, credentials or signed URLs on failure.
    return respond(empty, 503)
  }
}
