'use client'

import StorefrontContentManager from '@/components/dashboard/StorefrontContentManager'
import SectionEditor from '@/components/dashboard/SectionEditor'
import { sectionContent } from '@/lib/dashboard-storefront-content'

export default function SectionsPage() {
  return <StorefrontContentManager collection={sectionContent} Editor={SectionEditor} idPrefix="section" title="الأقسام التحريرية"
    description="جهّز صور الأقسام وروابطها وحدّد ترتيبها. لا تظهر هذه الأقسام في المتجر العام حالياً." />
}
