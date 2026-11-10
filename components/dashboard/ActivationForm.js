'use client'

import { useState } from 'react'
import { parseLicenseKey } from '@/lib/licenses'
import { supabase } from '@/lib/supabase'
import { fieldClass, primaryClass, Notice } from './EngineUI'
export default function ActivationForm({ onActivated, upgrade = false }) {
  const [key, setKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [done, setDone] = useState('')
  return <form onSubmit={async event => {
    event.preventDefault(); if (busy) return
    setBusy(true); setError(''); setDone('')
    try {
      if (!navigator.onLine) throw new Error('التفعيل يتطلب الاتصال بالإنترنت')
      // Shape/prefix pre-flight only; the server verifies the license row.
      const parsed = parseLicenseKey(key, upgrade ? 'UPG' : 'VTR')
      // Rethrow the server message verbatim: it distinguishes "not found" from
      // "already used" and carries the Arabic reason for a rejected key.
      const { error } = await supabase.rpc('engine_activate', { p_key: parsed.key })
      if (error) throw error
      setDone(upgrade
        ? `تمت ترقية الحساب بـ ${parsed.branches} فرع. سيتم تحديث الصفحة...`
        : `تم تفعيل الحساب بـ ${parsed.branches} فرع. سيتم تحديث الصفحة...`)
      onActivated?.()
    } catch (err) { setError(err.message) }
    finally { setBusy(false) }
  }} className="space-y-3">
    <label className="block text-sm">{upgrade ? 'مفتاح ترقية الفروع' : 'مفتاح التفعيل'}<input dir="ltr" placeholder={upgrade ? 'UPG-2-X7Y9Z2' : 'VTR-3-X7Y9Z2'} maxLength={200} autoComplete="off" required disabled={busy} value={key} onChange={e => setKey(e.target.value)} className={`${fieldClass} mt-2`} /></label>
    <Notice error={error} />
    {done && <p role="status" className="rounded-lg border border-emerald-700/40 bg-emerald-950/40 px-3 py-2 text-sm text-emerald-300">{done}</p>}
    <button disabled={busy} className={primaryClass}>{busy ? 'جاري التحقق...' : upgrade ? 'ترقية الفروع' : 'تفعيل الحساب'}</button>
  </form>
}
