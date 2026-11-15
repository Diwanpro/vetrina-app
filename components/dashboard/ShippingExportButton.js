'use client'

// P4 bulk CSV export trigger. Clicking it opens the same dark "الدرج المنزلق"
// drawer used by every other dashboard dropdown; the template list is derived
// from enabled bulk/both connections, never from hard-coded courier branches.

import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useDrawerMenu, drawerClass } from '@/components/ui/drawerMenu'

export default function ShippingExportButton({ templates = [], busy, disabled, onExport }) {
  const [isOpen, setIsOpen] = useState(false)
  const [rect, setRect] = useState(null)
  const triggerRef = useRef(null)
  const menuRef = useRef(null)
  const { mounted, phase } = useDrawerMenu(isOpen)
  const hasTemplates = Array.isArray(templates) && templates.length > 0

  const measure = () => {
    const node = triggerRef.current
    if (!node) return null
    const box = node.getBoundingClientRect()
    const next = { top: box.bottom + 4, left: box.left, width: Math.max(box.width, 260) }
    setRect(next)
    return next
  }

  useEffect(() => {
    if (!mounted) return
    const update = () => measure()
    update()
    window.addEventListener('resize', update)
    window.addEventListener('scroll', update, true)
    return () => {
      window.removeEventListener('resize', update)
      window.removeEventListener('scroll', update, true)
    }
  }, [mounted])

  useEffect(() => {
    if (!isOpen) return
    const onPointerDown = event => {
      if (triggerRef.current?.contains(event.target)) return
      if (menuRef.current?.contains(event.target)) return
      setIsOpen(false)
    }
    const onKeyDown = event => {
      if (event.key === 'Escape') setIsOpen(false)
    }
    document.addEventListener('mousedown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [isOpen])

  const isDisabled = busy || disabled || !hasTemplates

  function toggle() {
    if (isDisabled) return
    setIsOpen(open => {
      if (!open) measure()
      return !open
    })
  }

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        disabled={isDisabled}
        title={!hasTemplates ? 'فعّل وضع «تصدير بالجملة» أو «كلاهما» من إعدادات شركات التوصيل' : undefined}
        aria-haspopup="listbox"
        aria-expanded={isOpen}
        aria-label="قوالب تصدير الشحنات"
        onClick={toggle}
        className="flex min-h-9 items-center gap-2 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 text-xs font-medium text-emerald-200 transition hover:bg-emerald-500/20 disabled:cursor-not-allowed disabled:opacity-50"
      >
        <span>{busy ? 'جاري التصدير...' : 'تصدير الشحنات (CSV)'}</span>
        <span aria-hidden="true" className={`transition-transform duration-200 ${isOpen ? 'rotate-180' : ''}`}>▼</span>
      </button>

      {mounted && hasTemplates && rect && typeof document !== 'undefined' && createPortal(
        <ul
          ref={menuRef}
          role="listbox"
          aria-label="اختر قالب شركة التوصيل"
          style={{ position: 'fixed', top: rect.top, left: rect.left, width: rect.width, zIndex: 80 }}
          className={`${drawerClass(phase)} max-h-72 overflow-y-auto rounded-lg border border-emerald-500/20 bg-[#1A1A1A] py-1 shadow-xl`}
        >
          {templates.map(template => (
            <li key={template.value}>
              <button
                type="button"
                role="option"
                aria-selected="false"
                onClick={event => {
                  event.stopPropagation()
                  setIsOpen(false)
                  onExport(template.value)
                }}
                className="w-full px-3 py-2 text-start text-sm text-neutral-200 transition-colors hover:bg-emerald-500/10 hover:text-emerald-200"
              >
                <span className="block truncate">{template.label}</span>
                {template.description && (
                  <span className="mt-0.5 block truncate text-[11px] text-neutral-500">{template.description}</span>
                )}
              </button>
            </li>
          ))}
        </ul>,
        document.body
      )}
    </>
  )
}
