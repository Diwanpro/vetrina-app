'use client'

// v3.1: «تخصص الفرع» belongs to each BRANCH, not to the account. This editor
// lists every branch of the tenant and lets the owner edit its specialty (and,
// for a «متعدد» branch, its default public-store theme) in place. Both lists
// use the shared dark «الدرج المنزلق» CustomSelect, not the browser default.

import { useEffect, useState } from 'react'
import CustomSelect from '@/components/ui/CustomSelect'
import { fieldClass } from '@/components/dashboard/EngineUI'
import { supabase } from '@/lib/supabase'
import { STORE_TYPE_OPTIONS, STORE_TYPES, normalizeStoreType } from '@/lib/store-catalog'
import { THEME_OPTIONS, THEME_LABELS, normalizeStoreTheme, resolveStoreTheme } from '@/lib/store-theme'

export default function BranchProfileEditor({ ctx, onSaved }) {
  const [rows, setRows] = useState([])
  const [drafts, setDrafts] = useState({})
  const [busyId, setBusyId] = useState('')
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')

  useEffect(() => {
    let live = true
    async function load() {
      // Fall back to the session's branch list while the RPC is unavailable
      // (e.g. an older cached session) so the editor still renders.
      const fallback = (ctx?.stores || []).map(store => ({
        id: store.id,
        name: store.name,
        slug: store.slug || '',
        store_type: normalizeStoreType(store.store_type),
        theme_key: normalizeStoreTheme(store.theme_key),
      }))
      try {
        const { data, error: rpcError } = await supabase.rpc('engine_list_branch_profiles')
        if (rpcError) throw rpcError
        if (!live) return
        const list = Array.isArray(data) ? data : []
        setRows(list.length ? list : fallback)
      } catch {
        if (live) setRows(fallback)
      }
    }
    if (ctx?.role === 'owner') load()
    return () => { live = false }
  }, [ctx?.role, ctx?.tenantId])

  function draftFor(row) {
    return drafts[row.id] || {
      store_type: normalizeStoreType(row.store_type),
      theme_key: normalizeStoreTheme(row.theme_key),
    }
  }

  function setDraft(row, patch) {
    setDrafts(current => ({ ...current, [row.id]: { ...draftFor(row), ...patch } }))
  }

  async function save(row) {
    if (busyId) return
    const draft = draftFor(row)
    setBusyId(row.id); setError(''); setSuccess('')
    try {
      const { error: rpcError } = await supabase.rpc('engine_set_branch_profile', {
        p_store: row.id,
        p_store_type: draft.store_type,
        p_theme_key: draft.theme_key,
      })
      if (rpcError) throw rpcError
      setRows(current => current.map(item => item.id === row.id
        ? { ...item, store_type: draft.store_type, theme_key: draft.theme_key }
        : item))
      setSuccess(`تم حفظ تخصص فرع «${row.name}»`)
      onSaved?.()
    } catch (err) {
      setError(err.message || 'تعذر حفظ تخصص الفرع')
    } finally {
      setBusyId('')
    }
  }

  if (ctx?.role !== 'owner') return null

  return (
    <div className="mb-4 space-y-2">
      <p className="mb-2 text-xs text-neutral-500">تخصص كل فرع محفوظ على الفرع نفسه. غيّره هنا لأي فرع دون التأثير على الفروع الأخرى.</p>
      {rows.map(row => {
        const draft = draftFor(row)
        const resolved = resolveStoreTheme(draft.store_type, draft.theme_key)
        return (
          <div key={row.id} className="rounded-xl border border-white/10 bg-white/[0.03] p-3">
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
              <div className="min-w-0">
                <p className="truncate text-sm text-neutral-200">{row.name}</p>
                {row.slug && <p className="truncate text-[11px] text-neutral-500" dir="ltr">/s/{row.slug}</p>}
              </div>
              <span className="rounded-full border border-gold/25 bg-gold/10 px-2.5 py-1 text-[11px] text-gold">
                {THEME_LABELS[resolved]}
              </span>
            </div>
            <div className="grid gap-2 sm:grid-cols-2">
              <div className="block text-xs text-neutral-300">
                <span className="mb-1 block">تخصص الفرع <span className="text-gold">*</span></span>
                <CustomSelect
                  value={draft.store_type}
                  disabled={busyId === row.id}
                  onChange={value => setDraft(row, { store_type: value })}
                  options={STORE_TYPE_OPTIONS}
                  aria-label={`تخصص فرع ${row.name}`}
                  className={`${fieldClass} mt-1`}
                />
              </div>
              {draft.store_type === STORE_TYPES.MIXED && (
                <div className="block text-xs text-neutral-300">
                  <span className="mb-1 block">القالب الافتراضي</span>
                  <CustomSelect
                    value={draft.theme_key}
                    disabled={busyId === row.id}
                    onChange={value => setDraft(row, { theme_key: value })}
                    options={THEME_OPTIONS}
                    aria-label={`قالب فرع ${row.name}`}
                    className={`${fieldClass} mt-1`}
                  />
                </div>
              )}
            </div>
            <button
              type="button"
              disabled={busyId === row.id}
              onClick={() => save(row)}
              className="mt-2 rounded-lg border border-gold/35 bg-gold/10 px-3 py-1.5 text-xs text-gold disabled:opacity-50"
            >
              {busyId === row.id ? 'جاري الحفظ...' : 'حفظ تخصص هذا الفرع'}
            </button>
          </div>
        )
      })}
      {error && <p role="alert" className="text-xs text-red-300">{error}</p>}
      {success && <p role="status" className="text-xs text-emerald-300">{success}</p>}
    </div>
  )
}
