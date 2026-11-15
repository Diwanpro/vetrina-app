import Storefront from '@/components/store/Storefront'
import { publicRpc } from '@/lib/public-store'
import { normalizeSlug, manifestHref, safeStoreIcon } from '@/lib/pwa/manifest'

// The store name, share image and PWA manifest are the first things a customer
// sees in a shared link, so they are resolved on the server from THIS branch.
// A failure here must never stop the page rendering.
export async function generateMetadata({ params }) {
  const { slug } = await params
  const safeSlug = normalizeSlug(slug)
  const manifest = manifestHref(safeSlug)
  const { data } = await publicRpc('get_store_by_slug', { p_slug: safeSlug })
  if (data?.name) {
    const icon = safeStoreIcon(data.logo_url)
    return {
      title: `${data.name} · تسوّق الآن`,
      description: `اطلب من ${data.name} عبر الهاتف، والدفع عند الاستلام.`,
      manifest,
      appleWebApp: {
        capable: true,
        statusBarStyle: 'black-translucent',
        title: data.name,
      },
      icons: icon ? [{ url: icon, type: 'image/png' }] : undefined,
      openGraph: {
        title: data.name,
        description: `تسوّق من ${data.name}`,
        ...(icon ? { images: [icon] } : {}),
      },
    }
  }
  return { title: 'متجر إلكتروني', manifest }
}

export default async function StorePage({ params }) {
  const { slug } = await params
  // The segment is already decoded by Next; decoding again would throw on '%'.
  return <Storefront slug={slug || ''} />
}
