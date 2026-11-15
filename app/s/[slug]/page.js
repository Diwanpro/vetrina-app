import Storefront from '@/components/store/Storefront'
import { publicRpc } from '@/lib/public-store'
import { normalizeSlug, manifestHref, safeStoreIcon, cleanStoreName } from '@/lib/pwa/manifest'

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
    const name = cleanStoreName(data.name)
    return {
      title: { absolute: `${name} · تسوّق الآن` },
      applicationName: name,
      description: `اطلب من ${name} عبر الهاتف، والدفع عند الاستلام.`,
      manifest,
      appleWebApp: {
        capable: true,
        statusBarStyle: 'black-translucent',
        title: name,
      },
      icons: icon ? [{ url: icon, type: 'image/png' }] : undefined,
      openGraph: {
        title: name,
        description: `تسوّق من ${name}`,
        ...(icon ? { images: [icon] } : {}),
      },
    }
  }
  return { title: { absolute: 'متجر إلكتروني' }, applicationName: 'المتجر',
    description: 'تسوّق من المتجر عبر الهاتف، والدفع عند الاستلام.',
    appleWebApp: { capable: true, title: 'المتجر', statusBarStyle: 'black-translucent' }, manifest }
}

export default async function StorePage({ params }) {
  const { slug } = await params
  // The segment is already decoded by Next; decoding again would throw on '%'.
  return <Storefront slug={slug || ''} />
}
