'use client'

import BottomSheet from './BottomSheet'
import StorefrontContentForm, { useContentEditor } from './StorefrontContentForm'
import { bannerContent } from '@/lib/dashboard-storefront-content'

export default function BannerEditor(props) {
  const editor = useContentEditor(bannerContent, props)
  return <BottomSheet open title={props.original ? 'تعديل البانر' : 'إضافة بانر جديد'} labelledBy="banner-editor-title" onClose={editor.close}>
    <StorefrontContentForm idPrefix="banner" original={props.original} signedUrl={props.signedUrl} editor={editor} />
  </BottomSheet>
}
