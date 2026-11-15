// HID / Keyboard-Wedge barcode scanner support (P5).
//
// A keyboard-wedge scanner types a barcode as very fast keystrokes followed by
// Enter (or Tab). Normal human typing is slower than WEDGE_DEFAULTS.maxInterKeyMs,
// so requiring a fast, long, ASCII-only run avoids hijacking ordinary inputs.
// The React listener only listens on fields explicitly marked with
// `data-barcode-input`, or on the page body, and writes through the native
// value setter so React controlled inputs receive the usual `input` event.

export const WEDGE_DEFAULTS = Object.freeze({
  minLength: 8,
  maxLength: 64,
  maxInterKeyMs: 35,
  maxTotalMs: 1200,
  flushDelayMs: 90,
  pattern: /^[A-Za-z0-9._-]+$/,
  selector: '[data-barcode-input]',
})

export function normalizeBarcode(value) {
  return String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim()
}

export function createKeyboardWedgeBuffer(options = {}) {
  const config = { ...WEDGE_DEFAULTS, ...options }
  let chars = ''
  let startedAt = 0
  let lastAt = 0

  function reset() {
    chars = ''
    startedAt = 0
    lastAt = 0
  }

  function finish(now = Date.now()) {
    const code = normalizeBarcode(chars)
    const valid = code.length >= config.minLength
      && code.length <= config.maxLength
      && config.pattern.test(code)
      && now - startedAt <= config.maxTotalMs
    reset()
    return valid ? { handled: true, code } : { handled: false, buffered: 0 }
  }

  return {
    reset,
    flush: finish,
    key(event, now = Date.now()) {
      if (event.ctrlKey || event.metaKey || event.altKey || event.isComposing || event.repeat) {
        reset()
        return { handled: false, buffered: 0 }
      }
      const key = event.key
      if (key === 'Escape') {
        reset()
        return { handled: false, buffered: 0 }
      }
      if (key === 'Enter' || key === 'Tab') return finish(now)
      if (typeof key !== 'string' || key.length !== 1 || !config.pattern.test(key)) {
        reset()
        return { handled: false, buffered: 0 }
      }
      if (chars && (now - lastAt > config.maxInterKeyMs || now - startedAt > config.maxTotalMs)) reset()
      if (!chars) startedAt = now
      chars += key
      lastAt = now
      if (chars.length > config.maxLength) {
        reset()
        return { handled: false, buffered: 0 }
      }
      return { handled: false, buffered: chars.length }
    },
  }
}

export function isMarkedBarcodeTarget(target, selector = WEDGE_DEFAULTS.selector) {
  if (!target || target.nodeType !== 1) return false
  return typeof target.matches === 'function' && target.matches(selector)
}

/** Writes into a React-controlled input without losing its onChange handler. */
export function fillControlledInput(target, code) {
  if (!target || typeof window === 'undefined') return false
  const clean = normalizeBarcode(code)
  if (!clean) return false
  const isTextarea = target instanceof window.HTMLTextAreaElement
  const prototype = isTextarea ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype
  const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set
  if (setter) setter.call(target, clean)
  else target.value = clean
  target.dispatchEvent(new window.Event('input', { bubbles: true }))
  return true
}
