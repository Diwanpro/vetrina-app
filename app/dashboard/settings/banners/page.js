'use client'

import StorefrontContentManager from '@/components/dashboard/StorefrontContentManager'
import BannerEditor from '@/components/dashboard/BannerEditor'
import { bannerContent } from '@/lib/dashboard-storefront-content'

export default function BannersPage() {
  return <StorefrontContentManager collection={bannerContent} Editor={BannerEditor} idPrefix="banner" title="إدارة البانرات"
    description="رتّب صور البانرات وحدّد روابطها وحالة نشرها لهذا الفرع." />
}
