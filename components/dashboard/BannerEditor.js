'use client'

import { useEffect, useRef, useState } from 'react'
import BottomSheet from './BottomSheet'
import { Notice, fieldClass, primaryClass, secondaryClass } from './EngineUI'
import { BANNER_IMAGE_TYPES, imageExtension, saveBanner } from '@/lib/dashboard-banners'

export function BannerPreview({ src, alt, empty = 'لا تتوفر معاينة' }) {
  const [failed, setFailed] = useState(null)
  return src && src !== failed
    ? <img src={src} alt={alt} loading="lazy" referrerPolicy="no-referrer" onError={() => setFailed(src)} className="h-full w-full object-cover" />
    : <span className="px-2 text-center text-xs text-neutral-400">{empty}</span>
}

export default function BannerEditor({ tenantId, storeId, original, signedUrl, onClose, onSaved }) {
  const [draft, setDraft] = useState(() => ({ title: original?.title || '', link_url: original?.link_url || '',
    sort_order: String(original?.sort_order ?? 0), status: original?.status || 'draft' }))
  const [file, setFile] = useState(null)
  const [localUrl, setLocalUrl] = useState('')
  const [fileError, setFileError] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [unconfirmed, setUnconfirmed] = useState(false)
  const pending = useRef(false), live = useRef(false)
  useEffect(() => { live.current = true; return () => { live.current = false } }, [])
  useEffect(() => {
    if (!file) { setLocalUrl(''); return }
    // A new, unsaved file stays on this device until Save. Stored images only use signedUrl.
    const url = URL.createObjectURL(file)
    setLocalUrl(url)
    return () => URL.revokeObjectURL(url)
  }, [file])
  function change(key, value) { setDraft(previous => ({ ...previous, [key]: value })); setError('') }
  function chooseFile(event) {
    const next = event.target.files?.[0] || null
    setError(''); setFileError('')
    try { if (next) imageExtension(next); setFile(next) }
    catch (err) { event.target.value = ''; setFile(null); setFileError(err.message) }
  }
  function close() { if (!pending.current) onClose(unconfirmed) }
  async function submit(event) {
    event.preventDefault()
    if (pending.current || unconfirmed || fileError) return
    pending.current = true; setBusy(true); setError('')
    try {
      await saveBanner({ tenantId, storeId, original, draft, file, isActive: () => live.current })
      if (live.current) onSaved()
    } catch (err) {
      if (live.current) { setError(err.message || 'تعذر حفظ البانر.'); setUnconfirmed(Boolean(err.unconfirmed)) }
    } finally { pending.current = false; if (live.current) setBusy(false) }
  }

  return <BottomSheet open title={original ? 'تعديل البانر' : 'إضافة بانر جديد'} labelledBy="banner-editor-title" onClose={close}>
    <form onSubmit={submit} noValidate className="space-y-4" aria-busy={busy}>
      <Notice error={fileError || error} />
      <fieldset disabled={busy || unconfirmed} className="min-w-0 space-y-4">
        <label className="block text-sm">عنوان البانر
          <input required value={draft.title} onChange={e => change('title', e.target.value)} className={`${fieldClass} mt-1`} />
        </label>
        <div className="space-y-2">
          <div className="flex aspect-[3/1] items-center justify-center overflow-hidden rounded-xl border border-white/10 bg-black/30">
            <BannerPreview src={file ? localUrl : signedUrl} alt="معاينة صورة البانر" empty={original?.image_url ? 'لا تتوفر معاينة' : 'معاينة الصورة'} />
          </div>
          <label className="block text-sm">صورة البانر
            <input type="file" accept={BANNER_IMAGE_TYPES} onChange={chooseFile} aria-describedby="banner-image-help"
              className="mt-1 block w-full rounded-lg border border-white/15 p-2 text-xs text-neutral-300 file:me-2 file:rounded file:border-0 file:bg-white/10 file:px-3 file:py-1 file:text-white" />
          </label>
          <p id="banner-image-help" className="text-xs text-neutral-400">JPEG أو PNG أو WebP، حتى 8 ميبيبايت. تُرفع الصورة عند الحفظ.</p>
          {fileError && original?.image_url && <button type="button" onClick={() => setFileError('')} className="text-xs text-gold underline">الاحتفاظ بالصورة الحالية</button>}
        </div>
        <label className="block text-sm">الرابط (اختياري)
          <input dir="ltr" type="text" inputMode="url" placeholder="https://…" value={draft.link_url} onChange={e => change('link_url', e.target.value)} className={`${fieldClass} mt-1`} />
        </label>
        <label className="block text-sm">الترتيب
          <input type="number" inputMode="numeric" min="0" max="2147483647" step="1" required value={draft.sort_order}
            onChange={e => change('sort_order', e.target.value)} className={`${fieldClass} mt-1`} />
        </label>
        <fieldset><legend className="mb-1 text-sm">حالة البانر</legend>
          <div className="grid grid-cols-2 gap-2">{[['draft', 'مسودة'], ['published', 'منشور']].map(([value, label]) =>
            <label key={value} className={`flex min-h-11 items-center gap-2 rounded-lg border px-3 text-sm ${draft.status === value ? 'border-gold/50 bg-gold/10 text-gold' : 'border-white/10 text-neutral-300'}`}>
              <input type="radio" name="banner-status" value={value} checked={draft.status === value} onChange={() => change('status', value)} className="accent-gold" />{label}
            </label>)}
          </div>
        </fieldset>
      </fieldset>
      <div className="flex gap-2 border-t border-white/10 pt-3">
        <button type="submit" disabled={busy || unconfirmed || !!fileError} className={`${primaryClass} min-h-11 flex-1`}>{busy ? 'جاري الحفظ…' : 'حفظ البانر'}</button>
        <button type="button" disabled={busy} onClick={close} className={`${secondaryClass} min-h-11`}>{unconfirmed ? 'العودة إلى القائمة' : 'إلغاء'}</button>
      </div>
    </form>
  </BottomSheet>
}
