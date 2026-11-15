// Browser-only PWA helpers (v3.1). Pure functions, safe to unit-test in Node.

import { manifestHref, safeStoreIcon } from './manifest.js'

export { manifestHref, safeStoreIcon }

/** VAPID public keys arrive as URL-safe base64; PushManager wants Uint8Array. */
export function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (String(base64String).length % 4)) % 4)
  const base64 = (String(base64String) + padding).replace(/-/g, '+').replace(/_/g, '/')
  const raw = typeof atob === 'function'
    ? atob(base64)
    : Buffer.from(base64, 'base64').toString('binary')
  return Uint8Array.from(raw, char => char.charCodeAt(0))
}

export function isStandalone() {
  if (typeof window === 'undefined') return false
  return window.matchMedia?.('(display-mode: standalone)').matches
    || window.navigator?.standalone === true
}

export function isIosSafari() {
  if (typeof navigator === 'undefined') return false
  const ua = navigator.userAgent || ''
  return /iPad|iPhone|iPod/.test(ua) && !/CriOS|FxiOS|EdgiOS/.test(ua)
}
