'use client'

import { useEffect, useRef, useState } from 'react'
import { Notice, fieldClass, primaryClass, secondaryClass } from './EngineUI'
import StorefrontImageField from './StorefrontImageField'

// Both sheets guard closing/re-submitting an in-flight or unconfirmed write.
// The sheet binds its own collection; the form cannot choose a table or branch.
export function useContentEditor(collection, { tenantId, storeId, original, onClose, onSaved }) {
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [unconfirmed, setUnconfirmed] = useState(false)
  const pending = useRef(false), live = useRef(false)
  useEffect(() => { live.current = true; return () => { live.current = false } }, [])

  function close() { if (!pending.current) onClose(unconfirmed) }
  async function save(draft, file) {
    if (pending.current || unconfirmed) return
    pending.current = true; setBusy(true); setError('')
    try {
      await collection.save({ tenantId, storeId, original, draft, file, isActive: () => live.current })
      if (live.current) onSaved()
    } catch (err) {
      if (live.current) { setError(err.message || `تعذر حفظ ${collection.label}.`); setUnconfirmed(Boolean(err.unconfirmed)) }
    } finally { pending.current = false; if (live.current) setBusy(false) }
  }
  return { label: collection.label, busy, unconfirmed, error, clearError: () => setError(''), close, save }
}

export default function StorefrontContentForm({ idPrefix, editor, original, signedUrl }) {
  const { label, busy, unconfirmed } = editor
  const [draft, setDraft] = useState(() => ({ title: original?.title || '', link_url: original?.link_url || '',
    sort_order: String(original?.sort_order ?? 0), status: original?.status || 'draft' }))
  const [file, setFile] = useState(null)
  const [fileError, setFileError] = useState('')
  function change(key, value) { setDraft(previous => ({ ...previous, [key]: value })); editor.clearError() }
  function chooseFile(next, message) { setFile(next); setFileError(message); editor.clearError() }
  function submit(event) { event.preventDefault(); if (!fileError) editor.save(draft, file) }

  return <form onSubmit={submit} noValidate className="space-y-4" aria-busy={busy}>
    <Notice error={fileError || editor.error} />
    <fieldset disabled={busy || unconfirmed} className="min-w-0 space-y-4">
      <label className="block text-sm">عنوان {label}
        <input required value={draft.title} onChange={e => change('title', e.target.value)} className={`${fieldClass} mt-1`} />
      </label>
      <StorefrontImageField idPrefix={idPrefix} label={label} existingKey={original?.image_url} signedUrl={signedUrl}
        file={file} error={fileError} onChange={chooseFile} />
      <label className="block text-sm">الرابط (اختياري)
        <input dir="ltr" type="text" inputMode="url" placeholder="https://…" value={draft.link_url} onChange={e => change('link_url', e.target.value)} className={`${fieldClass} mt-1`} />
      </label>
      <label className="block text-sm">الترتيب
        <input type="number" inputMode="numeric" min="0" max="2147483647" step="1" required value={draft.sort_order}
          onChange={e => change('sort_order', e.target.value)} className={`${fieldClass} mt-1`} />
      </label>
      <fieldset><legend className="mb-1 text-sm">حالة {label}</legend>
        <div className="grid grid-cols-2 gap-2">{[['draft', 'مسودة'], ['published', 'منشور']].map(([value, text]) =>
          <label key={value} className={`flex min-h-11 items-center gap-2 rounded-lg border px-3 text-sm ${draft.status === value ? 'border-gold/50 bg-gold/10 text-gold' : 'border-white/10 text-neutral-300'}`}>
            <input type="radio" name={`${idPrefix}-status`} value={value} checked={draft.status === value} onChange={() => change('status', value)} className="accent-gold" />{text}
          </label>)}
        </div>
      </fieldset>
    </fieldset>
    <div className="flex gap-2 border-t border-white/10 pt-3">
      <button type="submit" disabled={busy || unconfirmed || !!fileError} className={`${primaryClass} min-h-11 flex-1`}>{busy ? 'جاري الحفظ…' : `حفظ ${label}`}</button>
      <button type="button" disabled={busy} onClick={editor.close} className={`${secondaryClass} min-h-11`}>{unconfirmed ? 'العودة إلى القائمة' : 'إلغاء'}</button>
    </div>
  </form>
}
