import Storefront from '@/components/store/Storefront'
import { publicRpc } from '@/lib/public-store'

// The store name is the first thing a customer sees in a shared link, so it is
// resolved on the server. A failure here must never stop the page rendering.
export async function generateMetadata({ params }) {
  const { slug } = await params
  const { data } = await publicRpc('get_store_by_slug', { p_slug: slug })
  if (data?.name) {
    return {
      title: `${data.name} · تسوّق الآن`,
      description: `اطلب من ${data.name} عبر الهاتف، والدفع عند الاستلام.`,
      openGraph: {
        title: data.name,
        description: `تسوّق من ${data.name}`,
        ...(data.logo_url ? { images: [data.logo_url] } : {}),
      },
    }
  }
  return { title: 'متجر إلكتروني' }
}

export default async function StorePage({ params }) {
  const { slug } = await params
  // The segment is already decoded by Next; decoding again would throw on '%'.
  return <Storefront slug={slug || ''} />
}
