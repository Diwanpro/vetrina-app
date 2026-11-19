'use client'

import BottomSheet from './BottomSheet'
import StorefrontContentForm, { useContentEditor } from './StorefrontContentForm'
import { sectionContent } from '@/lib/dashboard-storefront-content'

export default function SectionEditor(props) {
  const editor = useContentEditor(sectionContent, props)
  return <BottomSheet open title={props.original ? 'تعديل القسم' : 'إضافة قسم جديد'} labelledBy="section-editor-title" onClose={editor.close}>
    <StorefrontContentForm idPrefix="section" original={props.original} signedUrl={props.signedUrl} editor={editor} />
  </BottomSheet>
}
