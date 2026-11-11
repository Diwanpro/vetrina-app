'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { supabase } from '@/lib/supabase'
import { fieldClass, secondaryClass } from '@/components/dashboard/EngineUI'

// Type-ahead over the tenant's customers, plus an explicit "new customer" mode.
// Picking an existing row hands back its id so the caller never has to guess by
// name: the whole duplicate-customer class of bug comes from guessing.
export default function CustomerPicker({ tenantId, value, onChange, disabled = false }) {
  const [query, setQuery] = useState('')
  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(false)
  const [open, setOpen] = useState(false)
  const [error, setError] = useState('')
  const [creating, setCreating] = useState(false)
  const box = useRef(null)

  // `value` may arrive pre-filled (an existing customer chosen earlier).
  const selected = value?.id ? value : null

  useEffect(() => {
    if (!tenantId) return
    let live = true
    const term = query.trim()
    if (!creating && term.length < 2) { setRows([]); return }
    setLoading(true)
    // Escape the LIKE wildcards so a literal % or _ does not match everything.
    const escaped = term.replace(/[%_\\]/g, '\\$&')
    const pattern = `%${escaped}%`
    const timer = setTimeout(async () => {
      try {
        // `error` here used to shadow the state setter, so a failed query was
        // thrown and re-caught with nowhere to show it. Name it and surface it.
        const { data, error: queryError } = await supabase
          .from('customers')
          .select('id, name, phone')
          .eq('tenant_id', tenantId)
          // Name or phone: a cashier is as likely to have the number on screen
          // as the name, and a phone match is a stronger identity signal.
          .or(`name.ilike.${pattern},phone.ilike.${pattern}`)
          .order('name')
          .limit(8)
        if (queryError) throw queryError
        if (live) { setRows(data || []); setError('') }
      } catch (err) {
        if (!live) return
        console.error('[customer-picker] search failed', err)
        setRows([])
        setError('تعذر البحث عن الزبائن، تحقق من الاتصال')
      }
      finally { if (live) setLoading(false) }
    }, 250)
    return () => { live = false; clearTimeout(timer) }
  }, [query, tenantId, creating])

  useEffect(() => {
    const dismiss = event => { if (box.current && !box.current.contains(event.target)) setOpen(false) }
    document.addEventListener('mousedown', dismiss)
    return () => document.removeEventListener('mousedown', dismiss)
  }, [])

  const exactMatch = useMemo(() => {
    const key = query.trim().replace(/\s+/g, ' ').toLowerCase()
    return key ? rows.find(row => String(row.name || '').trim().replace(/\s+/g, ' ').toLowerCase() === key) : null
  }, [rows, query])

  function pick(row) {
    onChange({ id: row.id, name: row.name, phone: row.phone || '' })
    setQuery(row.name)
    setOpen(false)
    setCreating(false)
  }

  function startNew() {
    const name = query.trim().replace(/\s+/g, ' ')
    onChange({ id: null, name, phone: value?.phone || '' })
    setCreating(true)
    setOpen(false)
  }

  function clear() {
    onChange({ id: null, name: '', phone: '' })
    setQuery(''); setRows([]); setCreating(false); setOpen(false)
  }

  if (selected) {
    return <div className="flex items-center justify-between gap-2 rounded-lg border border-emerald-800/40 bg-emerald-950/20 px-3 py-2">
      <div className="min-w-0">
        <p className="truncate text-sm text-neutral-100">{selected.name}</p>
        <p className="text-[11px] text-emerald-300">زبون موجود{selected.phone ? ` · ${selected.phone}` : ''}</p>
      </div>
      <button type="button" disabled={disabled} onClick={clear} className="shrink-0 text-xs text-neutral-400 disabled:opacity-50">تغيير</button>
    </div>
  }

  return <div ref={box} className="relative space-y-2">
    {creating ? <div className="rounded-lg border border-gold/30 bg-gold/5 p-3">
      <p className="text-xs text-gold">زبون جديد</p>
      <input autoFocus disabled={disabled} value={value?.name || ''} maxLength={200}
        onChange={e => onChange({ id: null, name: e.target.value, phone: value?.phone || '' })}
        className={`${fieldClass} mt-2`} placeholder="اسم الزبون الكامل" />
      <input disabled={disabled} value={value?.phone || ''} maxLength={30} dir="ltr"
        onChange={e => onChange({ id: null, name: value?.name || '', phone: e.target.value })}
        className={`${fieldClass} mt-2`} placeholder="رقم الهاتف (اختياري)" />
      <button type="button" disabled={disabled} onClick={() => { setCreating(false); setQuery('') }}
        className={`${secondaryClass} mt-2`}>إلغاء، ابحث عن زبون موجود</button>
    </div> : <>
      <input
        type="text"
        disabled={disabled}
        value={query}
        placeholder="ابحث باسم الزبون..."
        autoComplete="off"
        role="combobox"
        aria-expanded={open}
        aria-controls="customer-picker-list"
        onChange={e => { setQuery(e.target.value); setOpen(true) }}
        onFocus={() => setOpen(true)}
        className={fieldClass}
      />
      {error && <p className="text-xs text-red-300">{error}</p>}
      {open && query.trim().length >= 2 && <div id="customer-picker-list" role="listbox"
        className="absolute inset-x-0 z-10 max-h-56 overflow-y-auto rounded-lg border border-gold/20 bg-[#1A1A1A] shadow-2xl">
        {loading && <p className="px-3 py-2 text-xs text-neutral-400">جاري البحث...</p>}
        {!loading && rows.length === 0 && <p className="px-3 py-2 text-xs text-neutral-500">لا يوجد زبون بهذا الاسم</p>}
        {rows.map(row => <button key={row.id} type="button" role="option" aria-selected={false}
          onClick={() => pick(row)}
          className="flex w-full items-center justify-between gap-2 border-t border-white/5 px-3 py-2 text-right text-sm text-neutral-200 hover:bg-gold/10">
          <span className="truncate">{row.name}</span>
          {row.phone && <span dir="ltr" className="shrink-0 text-[11px] text-neutral-500">{row.phone}</span>}
        </button>)}
        {!loading && !exactMatch && <button type="button" onClick={startNew}
          className="w-full border-t border-gold/20 px-3 py-2 text-right text-xs text-gold hover:bg-gold/10">
          + زبون جديد «{query.trim()}»
        </button>}
      </div>}
      {query.trim().length > 0 && query.trim().length < 2 &&
        <p className="text-[11px] text-neutral-500">اكتب حرفين على الأقل للبحث</p>}
    </>}
  </div>
}
