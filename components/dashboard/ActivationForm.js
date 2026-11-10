'use client'

import { useState } from 'react'
import { licenseBranches } from '@/lib/commercial'
import { supabase } from '@/lib/supabase'
import { fieldClass, primaryClass, Notice } from './EngineUI'
export default function ActivationForm({ onActivated, upgrade = false }) {
  const [key, setKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  return <form onSubmit={async event => {
    event.preventDefault(); if (busy) return
    setBusy(true); setError('')
    try {
      if (!navigator.onLine) throw new Error('التفعيل يتطلب الاتصال بالإنترنت')
      licenseBranches(key, upgrade ? 'UPG' : 'VTR')
      const { error } = await supabase.rpc('engine_activate', { p_key: key.trim() })
      if (error) throw error
      onActivated?.()
    } catch (err) { setError(err.message) }
    finally { setBusy(false) }
  }} className="space-y-3">
    <label className="block text-sm">{upgrade ? 'مفتاح ترقية الفروع' : 'مفتاح التفعيل'}<input dir="ltr" placeholder={upgrade ? 'UPG-2-...' : 'VTR-3-...'} maxLength={200} autoComplete="off" required disabled={busy} value={key} onChange={e => setKey(e.target.value)} className={`${fieldClass} mt-2`} /></label>
    <Notice error={error} />
    <button disabled={busy} className={primaryClass}>{busy ? 'جاري التحقق...' : upgrade ? 'ترقية الفروع' : 'تفعيل الحساب'}</button>
  </form>
}
