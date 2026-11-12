'use client'

import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

/**
 * Accessible custom dropdown.
 *
 * The options list is rendered through a portal into document.body and
 * positioned with `position: fixed` from the trigger's bounding box. That is
 * deliberate: absolutely positioned menus were being clipped by scroll
 * containers such as `overflow-y-auto` modal panels and `overflow-x-auto`
 * tables, which made the menu look like it never opened.
 *
 * The trigger is a real <button type="button">, never a <div> inside a
 * <label>. A <button> is a labelable element, so wrapping this widget in a
 * <label> made the browser forward clicks to the first option button once the
 * menu was open.
 */
export default function CustomSelect({
  value,
  onChange,
  options = [],
  disabled = false,
  className = '',
  placeholder = 'اختر...',
  label = '',
  id,
  name,
  title,
  'aria-label': ariaLabel,
}) {
  const [isOpen, setIsOpen] = useState(false)
  const [rect, setRect] = useState(null)
  const triggerRef = useRef(null)
  const menuRef = useRef(null)

  const selected = options.find(option => option.value === value)
  const selectedLabel = selected ? selected.label : placeholder

  const measure = () => {
    const node = triggerRef.current
    if (!node) return null
    const box = node.getBoundingClientRect()
    const next = { top: box.bottom + 4, left: box.left, width: box.width }
    setRect(next)
    return next
  }

  // Keep a fixed-position menu glued to the trigger while the page scrolls or
  // resizes. `true` captures scroll events from inner scroll containers too.
  useEffect(() => {
    if (!isOpen) return
    const update = () => measure()
    update()
    window.addEventListener('resize', update)
    window.addEventListener('scroll', update, true)
    return () => {
      window.removeEventListener('resize', update)
      window.removeEventListener('scroll', update, true)
    }
  }, [isOpen])

  useEffect(() => {
    if (!isOpen) return
    const onPointerDown = (event) => {
      if (triggerRef.current?.contains(event.target)) return
      if (menuRef.current?.contains(event.target)) return
      setIsOpen(false)
    }
    const onKeyDown = (event) => {
      if (event.key === 'Escape') setIsOpen(false)
    }
    document.addEventListener('mousedown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [isOpen])

  function toggle() {
    if (disabled) return
    setIsOpen(open => {
      if (!open) measure()
      return !open
    })
  }

  return (
    <>
      {label && <span className="mb-1 block text-sm text-neutral-300">{label}</span>}
      <button
        ref={triggerRef}
        id={id}
        name={name}
        title={title}
        aria-label={ariaLabel}
        type="button"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={isOpen}
        onClick={toggle}
        className={`flex w-full items-center justify-between gap-2 rounded-lg border border-[#D4AF37]/40 bg-[#1A1A1A] px-3 py-2 text-sm text-white outline-none focus:border-gold disabled:cursor-not-allowed disabled:opacity-50 ${className}`}
      >
        <span className="truncate">{selectedLabel}</span>
        <span aria-hidden="true" className={`shrink-0 transition-transform ${isOpen ? 'rotate-180' : ''}`}>▼</span>
      </button>

      {isOpen && !disabled && rect && typeof document !== 'undefined' && createPortal(
        <ul
          ref={menuRef}
          role="listbox"
          aria-label={ariaLabel || label || undefined}
          style={{ position: 'fixed', top: rect.top, left: rect.left, width: rect.width, zIndex: 80 }}
          className="max-h-64 overflow-y-auto rounded-lg border border-gold/20 bg-[#1A1A1A] py-1 shadow-xl"
        >
          {options.map(option => (
            <li key={option.value}>
              <button
                type="button"
                role="option"
                aria-selected={option.value === value}
                onClick={(event) => {
                  event.stopPropagation()
                  onChange(option.value)
                  setIsOpen(false)
                }}
                className={`w-full px-3 py-2 text-start text-sm transition-colors ${
                  option.value === value
                    ? 'bg-gold/10 text-gold'
                    : 'text-neutral-300 hover:bg-white/5 hover:text-white'
                }`}
              >
                {option.label}
              </button>
            </li>
          ))}
        </ul>,
        document.body
      )}
    </>
  )
}
