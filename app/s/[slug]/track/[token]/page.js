import TrackOrder from '@/components/store/TrackOrder'

export const metadata = {
  title: 'تتبع الطلب',
  description: 'حالة طلبك خطوة بخطوة.',
}

export default async function TrackPage({ params }) {
  const { slug, token } = await params
  return <TrackOrder slug={slug || ''} token={token || ''} />
}
