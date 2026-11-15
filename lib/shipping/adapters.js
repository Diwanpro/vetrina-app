// SERVER-ONLY adapter registry. The browser never imports this file: it would
// pull in node:crypto and the mock/live transport. Adding a courier in P4+ is
// one adapter file + one line here; the gateway and UI stay unchanged.

import { normalizeProviderCode } from './contract.js'
import { yalidineAdapter } from './providers/yalidine.js'

export const ADAPTERS = Object.freeze({
  [yalidineAdapter.code]: yalidineAdapter,
})

export function getAdapter(code) {
  return ADAPTERS[normalizeProviderCode(code)] || null
}

export function listAdapterCodes() {
  return Object.keys(ADAPTERS)
}
