'use client'

import { useEffect, useState } from 'react'

/**
 * Keeps a dropdown mounted long enough to play its closing animation.
 *
 * The "درج منزلق" effect is CSS (see .vetrina-drawer--* in app/globals.css), but
 * CSS cannot animate an element that React has already removed. This hook
 * returns `mounted` (render while open OR closing) and `phase` (which animation
 * class to apply), so both CustomSelect and SearchableSelect open AND close
 * like a drawer instead of popping in and out.
 */
export const DRAWER_OPEN_MS = 240
export const DRAWER_CLOSE_MS = 180

export function useDrawerMenu(isOpen) {
  const [mounted, setMounted] = useState(Boolean(isOpen))

  useEffect(() => {
    if (isOpen) {
      setMounted(true)
      return undefined
    }
    if (!mounted) return undefined
    const timer = setTimeout(() => setMounted(false), DRAWER_CLOSE_MS)
    return () => clearTimeout(timer)
  }, [isOpen, mounted])

  return { mounted, phase: isOpen ? 'open' : 'closing' }
}

export function drawerClass(phase) {
  return `vetrina-drawer vetrina-drawer--${phase}`
}
