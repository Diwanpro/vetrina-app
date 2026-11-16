// Canonical shipping vocabulary, shared by the browser UI and the server
// gateway. This module is deliberately dependency-free and client-safe: it is
// imported by both the settings tab and the Next.js route handlers.

export const ENVIRONMENTS = Object.freeze(['sandbox', 'production'])
export const CONNECTION_MODES = Object.freeze(['api', 'bulk', 'both'])
export const SHIPMENT_MODES = Object.freeze(['api', 'bulk'])
export const DELIVERY_TYPES = Object.freeze(['home', 'stopdesk'])

export const SHIPMENT_STATUSES = Object.freeze([
  'created', 'in_transit', 'delivered', 'returned', 'cancelled', 'exported', 'failed',
])
export const EVENT_STATUSES = Object.freeze([
  'created', 'in_transit', 'delivered', 'returned', 'cancelled', 'unknown',
])

// One error taxonomy for every courier adapter (P3+), so the UI shows Arabic
// messages and retries only when retrying can help.
export const SHIPPING_ERROR_CODES = Object.freeze({
  CONFIG: 'CONFIG',
  AUTH: 'AUTH',
  VALIDATION: 'VALIDATION',
  AUTH_FAILED: 'AUTH_FAILED',
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  RATE_LIMITED: 'RATE_LIMITED',
  NETWORK_ERROR: 'NETWORK_ERROR',
  PROVIDER_ERROR: 'PROVIDER_ERROR',
  NOT_FOUND: 'NOT_FOUND',
  NOT_SUPPORTED: 'NOT_SUPPORTED',
  CONFLICT: 'CONFLICT',
  INTERNAL: 'INTERNAL',
})

export const PROVIDER_CODE_PATTERN = /^[a-z0-9_]{2,40}$/
export const WILAYA_CODE_PATTERN = /^[0-9]{2}$/

export function normalizeProviderCode(value) {
  return String(value ?? '').trim().toLowerCase()
}

export function isEnvironment(value) {
  return ENVIRONMENTS.includes(value)
}

export function isConnectionMode(value) {
  return CONNECTION_MODES.includes(value)
}

export function isShipmentStatus(value) {
  return SHIPMENT_STATUSES.includes(value)
}

export function isValidWilayaCode(value) {
  const code = String(value ?? '').trim()
  if (!WILAYA_CODE_PATTERN.test(code)) return false
  const number = Number(code)
  return Number.isInteger(number) && number >= 1 && number <= 58
}

export function isValidUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value ?? ''))
}

/** An error that carries an HTTP status and a stable machine-readable code. */
export class ShippingError extends Error {
  constructor(code, message, status = 400, details = null) {
    super(message)
    this.name = 'ShippingError'
    this.code = code
    this.status = status
    this.details = details
  }
}

export function shippingError(code, message, status = 400, details = null) {
  return new ShippingError(code, message, status, details)
}
