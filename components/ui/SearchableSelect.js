'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useDrawerMenu, drawerClass } from './drawerMenu'

/**
 * Combobox: pick an existing option or type a brand new one.
 *
 * Like CustomSelect, the menu is portalled into document.body and positioned
 * fixed, so scroll containers (modal panels use overflow-y-auto) cannot clip
 * it out of existence. It also uses the same "الدرج المنزلق" animation and
 * stays mounted while closing so the drawer retracts instead of blinking out.
 *
 * `onCreate(value)` fires only when the chosen row is a value that was not in
 * `options` — that is the caller's cue to persist it. It still calls
 * onChange(value) first, so the field updates even if persisting fails.
 */
export default function SearchableSelect({
  value = '',
  onChange,
  onCreate,
  options = [],
  allowCreate = true,
  getOptionLabel = option => option.label,
  placeholder = 'ابحث أو اكتب صنفاً جديداً…',
  emptyText = 'لا توجد نتائج',
  disabled = false,
  className = '',
  id,
  'aria-label': ariaLabel,
}) {
  const [isOpen, setIsOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [rect, setRect] = useState(null)
  const [active, setActive] = useState(0)
  const triggerRef = useRef(null)
  const menuRef = useRef(null)
  const inputRef = useRef(null)
  const { mounted, phase } = useDrawerMenu(isOpen)

  const trimmed = query.trim()
  const selectedOption = options.find(option => option.value === value)

  const rows = useMemo(() => {
    const q = trimmed.toLowerCase()
    const matched = q ? options.filter(option => getOptionLabel(option).toLowerCase().includes(q)) : options
    const list = matched.map(option => ({ ...option, kind: 'option' }))
    const exact = options.some(option => getOptionLabel(option).trim().toLowerCase() === q)
    if (allowCreate && trimmed && !exact) list.push({ label: trimmed, value: trimmed, kind: 'add' })
    return list
  }, [options, trimmed, allowCreate, getOptionLabel])

  // Keep the highlighted row inside the (filtered) list.
  useEffect(() => {
    if (active > rows.length - 1) setActive(Math.max(0, rows.length - 1))
  }, [rows.length, active])

  // Runs while `mounted` (not only isOpen) so the closing drawer stays aligned.
  useEffect(() => {
    if (!mounted) return
    if (isOpen) inputRef.current?.focus()
    const place = () => {
      const box = triggerRef.current?.getBoundingClientRect()
      if (box) setRect({ top: box.bottom + 4, left: box.left, width: box.width })
    }
    place()
    window.addEventListener('resize', place)
    window.addEventListener('scroll', place, true)
    return () => {
      window.removeEventListener('resize', place)
      window.removeEventListener('scroll', place, true)
    }
  }, [mounted, isOpen])

  useEffect(() => {
    if (!isOpen) return
    const onPointerDown = (event) => {
      if (triggerRef.current?.contains(event.target)) return
      if (menuRef.current?.contains(event.target)) return
      close()
    }
    const onKeyDown = (event) => {
      if (event.key === 'Escape') close()
    }
    document.addEventListener('mousedown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [isOpen])

  function close() {
    setIsOpen(false)
    setQuery('')
    setActive(0)
  }

  function choose(row) {
    if (!row) return
    onChange(row.value)
    if (row.kind === 'add') onCreate?.(row.value)
    close()
  }

  function onKeyDown(event) {
    if (event.key === 'Escape') {
      event.preventDefault()
      close()
    } else if (event.key === 'ArrowDown') {
      event.preventDefault()
      setActive(index => Math.min(index + 1, rows.length - 1))
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      setActive(index => Math.max(index - 1, 0))
    } else if (event.key === 'Enter') {
      event.preventDefault()
      choose(rows[active])
    }
  }

  return (
    <>
      <button
        ref={triggerRef}
        id={id}
        type="button"
        disabled={disabled}
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={isOpen}
        onClick={() => (isOpen ? close() : setIsOpen(true))}
        className={`flex w-full items-center justify-between gap-2 rounded-lg border border-[#D4AF37]/40 bg-[#1A1A1A] px-3 py-2 text-sm text-white outline-none focus:border-gold disabled:cursor-not-allowed disabled:opacity-50 ${className}`}
      >
        <span className={`truncate ${value ? '' : 'text-neutral-500'}`}>
          {selectedOption ? getOptionLabel(selectedOption) : (value || placeholder)}
        </span>
        <span aria-hidden="true" className={`shrink-0 transition-transform duration-200 ${isOpen ? 'rotate-180' : ''}`}>▼</span>
      </button>

      {mounted && !disabled && rect && createPortal(
        <div
          ref={menuRef}
          style={{ position: 'fixed', top: rect.top, left: rect.left, width: rect.width, zIndex: 80 }}
          className={`${drawerClass(phase)} overflow-hidden rounded-lg border border-gold/20 bg-[#1A1A1A] shadow-xl`}
        >
          <div className="border-b border-white/5 p-2">
            <input
              ref={inputRef}
              value={query}
              onChange={event => { setQuery(event.target.value); setActive(0) }}
              onKeyDown={onKeyDown}
              placeholder={allowCreate ? 'ابحث أو اكتب صنفاً جديداً…' : 'ابحث...'}
              className="w-full rounded-md border border-gold/20 bg-black/30 px-2 py-1.5 text-sm text-white outline-none focus:border-gold"
            />
          </div>
          <ul role="listbox" aria-label={ariaLabel} className="max-h-56 overflow-y-auto py-1">
            {!rows.length && (
              <li className="px-3 py-2 text-xs text-neutral-500">
                {allowCreate ? 'لا توجد نتائج — اكتب اسماً جديداً لإضافته.' : emptyText}
              </li>
            )}
            {rows.map((row, index) => (
              <li key={`${row.kind}-${row.value}`}>
                <button
                  type="button"
                  role="option"
                  aria-selected={row.kind === 'option' && row.value === value}
                  onMouseEnter={() => setActive(index)}
                  onClick={() => choose(row)}
                  className={`w-full px-3 py-2 text-start text-sm transition-colors ${
                    row.kind === 'add'
                      ? 'text-emerald-300 hover:bg-emerald-500/10'
                      : index === active || row.value === value
                        ? 'bg-gold/10 text-gold'
                        : 'text-neutral-300 hover:bg-white/5 hover:text-white'
                  }`}
                >
                  {row.kind === 'add' ? `إضافة "${row.label}"` : getOptionLabel(row)}
                </button>
              </li>
            ))}
          </ul>
        </div>,
        document.body
      )}
    </>
  )
}
