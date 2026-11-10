'use client'

import { useState } from 'react'
import { supabase } from '@/lib/supabase'
import { fieldClass, primaryClass, Notice } from './EngineUI'
export default function ActivationForm({ onActivated }) {
  const [key, setKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  return <form onSubmit={async event => {
    event.preventDefault(); if (busy) return
    setBusy(true); setError('')
    try {
      if (!navigator.onLine) throw new Error('التفعيل يتطلب الاتصال بالإنترنت')
      const { error } = await supabase.rpc('engine_activate', { p_key: key.trim() })
      if (error) throw error
      onActivated?.()
    } catch (err) { setError(err.message) }
    finally { setBusy(false) }
  }} className="space-y-3">
    <label className="block text-sm">مفتاح التفعيل<input dir="ltr" autoComplete="off" required disabled={busy} value={key} onChange={e => setKey(e.target.value)} className={`${fieldClass} mt-2`} /></label>
    <Notice error={error} />
    <button disabled={busy} className={primaryClass}>{busy ? 'جاري التفعيل...' : 'تفعيل الحساب'}</button>
  </form>
}
