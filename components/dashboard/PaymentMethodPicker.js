'use client'

import { useState } from 'react'
import BottomSheet from './BottomSheet'

/**
 * Payment method chooser for the cashier.
 *
 * The closed control keeps the exact look of the dashboard dropdown it
 * replaced (same border, background and trigger classes) and opens a bottom
 * sheet instead of a popup menu, so the three methods sit under the thumb on
 * a phone. The value contract is unchanged: `value` is one of the method keys
 * and `onChange(key)` fires once, immediately, on a tap.
 */
export default function PaymentMethodPicker({ value, onChange, options, disabled = false, label = 'طريقة الدفع' }) {
  const [open, setOpen] = useState(false)
  const selected = options.find(option => option.value === value)
  const selectedLabel = selected ? selected.label : 'اختر...'

  return (
    <div className="block">
      <span className="mb-1 block text-xs text-neutral-400">{label}</span>
      <button
        type="button"
        disabled={disabled}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(true)}
        className="flex w-full items-center justify-between gap-2 rounded-lg border border-[#D4AF37]/40 bg-[#1A1A1A] px-3 py-2 text-sm text-white outline-none focus:border-gold disabled:cursor-not-allowed disabled:opacity-50"
      >
        <span className="truncate">{selectedLabel}</span>
        <span aria-hidden="true" className={`shrink-0 transition-transform duration-200 ${open ? 'rotate-180' : ''}`}>▼</span>
      </button>

      <BottomSheet open={open} onClose={() => setOpen(false)} title={label} labelledBy="payment-method-title" closeLabel="إغلاق">
        <ul role="listbox" aria-label={label} className="space-y-1">
          {options.map(option => (
            <li key={option.value}>
              <button
                type="button"
                role="option"
                aria-selected={option.value === value}
                onClick={() => { onChange(option.value); setOpen(false) }}
                className={`flex w-full items-center justify-between gap-2 rounded-lg border px-3 py-3 text-start text-sm transition-colors ${
                  option.value === value
                    ? 'border-gold/40 bg-gold/10 text-gold'
                    : 'border-white/10 bg-black/20 text-neutral-200 hover:bg-white/5'
                }`}
              >
                <span>{option.label}</span>
                {option.value === value && <span aria-hidden="true" className="text-gold">✓</span>}
              </button>
            </li>
          ))}
        </ul>
      </BottomSheet>
    </div>
  )
}
