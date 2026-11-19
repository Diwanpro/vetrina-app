'use client'

import { useEffect, useState } from 'react'
import { imageExtension, STOREFRONT_IMAGE_TYPES } from '@/lib/dashboard-storefront-content'

export function AssetPreview({ src, alt, empty = 'لا تتوفر معاينة' }) {
  const [failed, setFailed] = useState(null)
  return src && src !== failed
    ? <img src={src} alt={alt} loading="lazy" referrerPolicy="no-referrer" onError={() => setFailed(src)} className="h-full w-full object-cover" />
    : <span className="px-2 text-center text-xs text-neutral-400">{empty}</span>
}

export default function StorefrontImageField({ idPrefix, label, existingKey, signedUrl, file, error, onChange }) {
  const [localUrl, setLocalUrl] = useState('')
  useEffect(() => {
    if (!file) { setLocalUrl(''); return }
    // An unsaved file stays on this device. A stored object uses only its signed URL.
    const url = URL.createObjectURL(file)
    setLocalUrl(url)
    return () => URL.revokeObjectURL(url)
  }, [file])

  function choose(event) {
    const next = event.target.files?.[0] || null
    try { if (next) imageExtension(next); onChange(next, '') }
    catch (err) { event.target.value = ''; onChange(null, err.message) }
  }
  const helpId = `${idPrefix}-image-help`
  return <div className="space-y-2">
    <div className="flex aspect-[3/1] items-center justify-center overflow-hidden rounded-xl border border-white/10 bg-black/30">
      <AssetPreview src={file ? localUrl : signedUrl} alt={`معاينة صورة ${label}`} empty={existingKey ? 'لا تتوفر معاينة' : 'معاينة الصورة'} />
    </div>
    <label className="block text-sm">صورة {label}
      <input type="file" accept={STOREFRONT_IMAGE_TYPES} onChange={choose} aria-describedby={helpId}
        className="mt-1 block w-full rounded-lg border border-white/15 p-2 text-xs text-neutral-300 file:me-2 file:rounded file:border-0 file:bg-white/10 file:px-3 file:py-1 file:text-white" />
    </label>
    <p id={helpId} className="text-xs text-neutral-400">JPEG أو PNG أو WebP، حتى 8 ميبيبايت. تُرفع الصورة عند الحفظ.</p>
    {error && existingKey && <button type="button" onClick={() => onChange(null, '')} className="text-xs text-gold underline">الاحتفاظ بالصورة الحالية</button>}
  </div>
}
