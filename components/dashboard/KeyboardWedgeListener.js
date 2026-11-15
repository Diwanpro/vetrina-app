'use client'

// Mount once on a screen that has a search/add field marked with
// `data-barcode-input`. HID scanners type into that field automatically; a
// scan with focus on the page body also lands in the first marked field.

import { useEffect, useRef } from 'react'
import {
  createKeyboardWedgeBuffer, fillControlledInput, isMarkedBarcodeTarget, WEDGE_DEFAULTS,
} from '@/lib/barcode/keyboard-wedge'

export default function KeyboardWedgeListener({
  onScan,
  selector = WEDGE_DEFAULTS.selector,
  enabled = true,
}) {
  const scanRef = useRef(onScan)
  scanRef.current = onScan

  useEffect(() => {
    if (!enabled || typeof window === 'undefined') return
    const buffer = createKeyboardWedgeBuffer({ selector })
    let timer = null

    function deliver(code, target) {
      if (timer) { window.clearTimeout(timer); timer = null }
      const input = target || document.querySelector(selector)
      if (input) fillControlledInput(input, code)
      scanRef.current?.(code, input || null)
    }

    function scheduleFlush(target) {
      if (timer) window.clearTimeout(timer)
      timer = window.setTimeout(() => {
        const result = buffer.flush()
        if (result.handled) deliver(result.code, target || document.querySelector(selector))
        timer = null
      }, WEDGE_DEFAULTS.flushDelayMs)
    }

    function onKeyDown(event) {
      const active = document.activeElement
      const marked = isMarkedBarcodeTarget(active, selector)
      const onShell = !active || active === document.body || active === document.documentElement
      if (!marked && !onShell) {
        buffer.reset()
        return
      }
      const result = buffer.key(event)
      const target = marked ? active : document.querySelector(selector)
      if (result.buffered) scheduleFlush(target)
      if (result.handled) {
        deliver(result.code, target)
        event.preventDefault()
        event.stopPropagation()
      }
    }

    window.addEventListener('keydown', onKeyDown, true)
    return () => {
      window.removeEventListener('keydown', onKeyDown, true)
      if (timer) window.clearTimeout(timer)
      buffer.reset()
    }
  }, [enabled, selector])

  return null
}
