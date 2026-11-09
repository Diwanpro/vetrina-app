'use client'

import { useState } from 'react'
import { IconChevron } from './icons'

const BRANCHES = ['الفرع الرئيسي', 'فرع وسط المدينة', 'فرع الزيانية']

export default function TopBar() {
  const [open, setOpen] = useState(false)
  const [branch, setBranch] = useState(BRANCHES[0])

  return (
    <header className="sticky top-0 z-30 border-b border-white/5 bg-[#141414]/95 backdrop-blur">
      <div className="flex items-center gap-2 px-3 py-2.5 md:px-4">
        <img
          src="/vetrina_logo_main.png"
          alt="Vetrina"
          className="md:hidden w-8 h-8 rounded-lg object-cover"
        />
        <div className="min-w-0 flex-1">
          <p className="text-sm text-neutral-100 truncate">الأحد 9 نوفمبر</p>
          <p className="text-[11px] text-neutral-500">آخر مزامنة: 02:25</p>
        </div>

        <div className="relative">
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            className="flex items-center gap-1 rounded-lg border border-white/10 bg-[#1c1c1c] px-2.5 py-1.5 text-xs text-neutral-200"
          >
            <span className="max-w-[96px] truncate">{branch}</span>
            <IconChevron className="w-3.5 h-3.5 text-gold" />
          </button>
          {open && (
            <div className="absolute top-full mt-1 end-0 z-40 min-w-[150px] rounded-lg border border-white/10 bg-[#1c1c1c] py-1 shadow-xl">
              {BRANCHES.map((item) => (
                <button
                  key={item}
                  type="button"
                  onClick={() => {
                    setBranch(item)
                    setOpen(false)
                  }}
                  className={`block w-full px-3 py-1.5 text-right text-xs ${
                    item === branch ? 'text-gold' : 'text-neutral-300'
                  }`}
                >
                  {item}
                </button>
              ))}
            </div>
          )}
        </div>

        <button
          type="button"
          className="shrink-0 rounded-lg bg-[#8B1E1E] px-2.5 py-1.5 text-[11px] font-medium text-red-100"
        >
          لم يُفتح اليوم بعد
        </button>
      </div>
    </header>
  )
}
