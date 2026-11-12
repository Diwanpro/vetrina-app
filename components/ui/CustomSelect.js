'use client'

import { useState, useEffect, useRef } from 'react'
import { fieldClass, primaryClass, secondaryClass } from '@/components/dashboard/EngineUI'

export default function CustomSelect({
  value,
  onChange,
  options, // Array of { label: string, value: string }
  disabled = false,
  className = '',
  placeholder = 'اختر...',
  label = '',
}) {
  const [isOpen, setIsOpen] = useState(false)
  const ref = useRef(null)

  useEffect(() => {
    const handleClickOutside = (event) => {
      if (ref.current && !ref.current.contains(event.target)) {
        setIsOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [])

  const selectedOption = options.find(opt => opt.value === value) || { label: placeholder, value: '' }

  return (
    <div ref={ref} className={`relative ${className}`} onClick={() => !disabled && setIsOpen(!isOpen)}>
      {label && <label className="block text-sm text-neutral-300 mb-1">{label}</label>}
      <div
        className={`flex items-center justify-between px-3 py-2 rounded-lg border ${
          disabled ? 'border-white/5 bg-black/10 text-neutral-500 cursor-not-allowed' : 'border-gold/20 bg-[#1A1A1A] text-white cursor-pointer hover:border-gold/40'
        } ${className}`}
      >
        <span className="truncate">{selectedOption.label}</span>
        <span className={`ml-2 transition-transform ${isOpen ? 'rotate-180' : ''}`}>▼</span>
      </div>

      {isOpen && !disabled && (
        <div className="absolute z-50 w-full mt-1 rounded-lg border border-gold/20 bg-[#1A1A1A] shadow-xl overflow-hidden">
          {options.map((opt) => (
            <button
              key={opt.value}
              type="button"
              onClick={() => {
                onChange(opt.value)
                setIsOpen(false)
              }}
              className={`w-full px-3 py-2 text-sm text-left transition-colors ${
                opt.value === value
                  ? 'bg-gold/10 text-gold'
                  : 'text-neutral-300 hover:bg-white/5 hover:text-white'
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
