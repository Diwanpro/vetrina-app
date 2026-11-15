// Provider registry — the ONLY place where courier-specific metadata lives.
//
// Client-safe by design: no node builtins, no secrets, no network calls. The
// dashboard imports this file to render the form; the server gateway imports it
// to validate input and build a connection probe. Adding a courier later means
// one entry here + one adapter file in lib/shipping/providers/ (P3+), with no
// new migration: provider_code is validated by shape, not by a CHECK enum.
//
// Credential/header shapes below come from third-party SDK docs and are
// intentionally overridable through environment variables. The authoritative
// field mapping is confirmed against each courier's Sandbox in P3/P4; until
// then the live probe only hits the configured base URL root, so it proves
// reachability without assuming a specific undocumented endpoint.

import {
  PROVIDER_CODE_PATTERN, normalizeProviderCode, isEnvironment, isConnectionMode,
} from './contract.js'

const YALIDINE = {
  code: 'yalidine',
  label: 'يليدين (Yalidine)',
  platform: 'Yalidine / GuepEx',
  originWilayaRequired: true,
  credentialFields: [
    { key: 'apiId', label: 'API ID', secret: false, required: true, placeholder: 'yalidine.app/dev' },
    { key: 'apiToken', label: 'API Token', secret: true, required: true, hint: true, placeholder: '••••••••' },
  ],
  // P3: the Yalidine adapter in lib/shipping/providers/yalidine.js implements
  // every live capability below (through the mock transport until keys arrive).
  capabilities: {
    create: true, track: true, label: true, cancel: true,
    webhook: true, pullStatuses: true, bulkTemplate: false, fees: false, test: true,
  },
  probe: {
    method: 'GET',
    path: '/',
    headers: { 'X-API-ID': '${apiId}', 'X-API-TOKEN': '${apiToken}', Accept: 'application/json' },
  },
}

const ZREXPRESS = {
  code: 'zrexpress',
  label: 'ZR Express (Procolis)',
  platform: 'Procolis · token + key',
  originWilayaRequired: false,
  credentialFields: [
    { key: 'token', label: 'Token', secret: true, required: true, placeholder: '••••••••' },
    { key: 'key', label: 'Key', secret: true, required: true, hint: true, placeholder: '••••••••' },
  ],
  capabilities: {
    create: false, track: false, label: false, cancel: false,
    webhook: false, pullStatuses: false, bulkTemplate: false, fees: false, test: true,
  },
  probe: {
    method: 'GET',
    path: '/',
    headers: { Authorization: 'Token ${token}', 'X-Api-Key': '${key}', Accept: 'application/json' },
  },
}

const ZREXPRESS_NEW = {
  code: 'zrexpressnew',
  label: 'ZR Express (المنصة الجديدة)',
  platform: 'zrexpress.app · apiKey + tenant',
  originWilayaRequired: false,
  credentialFields: [
    { key: 'apiKey', label: 'API Key', secret: true, required: true, placeholder: '••••••••' },
    { key: 'tenantId', label: 'Tenant ID', secret: false, required: true, hint: true, placeholder: 'uuid' },
  ],
  capabilities: {
    create: false, track: false, label: false, cancel: false,
    webhook: false, pullStatuses: false, bulkTemplate: false, fees: false, test: true,
  },
  probe: {
    method: 'GET',
    path: '/',
    headers: { 'X-Api-Key': '${apiKey}', 'X-Tenant': '${tenantId}', Accept: 'application/json' },
  },
}

export const PROVIDERS = Object.freeze({
  [YALIDINE.code]: Object.freeze(YALIDINE),
  [ZREXPRESS.code]: Object.freeze(ZREXPRESS),
  [ZREXPRESS_NEW.code]: Object.freeze(ZREXPRESS_NEW),
})

export function listProviders() {
  return [YALIDINE, ZREXPRESS, ZREXPRESS_NEW]
}

export function getProvider(code) {
  return PROVIDERS[normalizeProviderCode(code)] || null
}

export function credentialHintField(provider) {
  const fields = provider?.credentialFields || []
  return fields.find(field => field.hint) || [...fields].reverse().find(field => field.secret) || fields[0] || null
}

/**
 * Pure validation of the credential object. Bulk-only connections need no keys
 * at all; API/both must supply exactly the declared fields (no extras, so a
 * typo or an injected value can never be encrypted and stored).
 * Returns { ok, errors: string[], clean }.
 */
export function validateCredentials(provider, credentials, mode = 'api') {
  if (!provider) return { ok: false, errors: ['شركة التوصيل غير معروفة'], clean: {} }
  if (!isConnectionMode(mode)) return { ok: false, errors: ['استراتيجية الربط غير صالحة'], clean: {} }
  if (mode === 'bulk') return { ok: true, errors: [], clean: {} }

  if (!credentials || typeof credentials !== 'object' || Array.isArray(credentials)) {
    return { ok: false, errors: ['مفاتيح الشركة مطلوبة'], clean: {} }
  }

  const errors = []
  const clean = {}
  const declared = new Set(provider.credentialFields.map(field => field.key))

  for (const key of Object.keys(credentials)) {
    if (!declared.has(key)) errors.push(`حقل غير معروف: ${key}`)
  }
  for (const field of provider.credentialFields) {
    const value = credentials[field.key]
    if (typeof value !== 'string' || !value.trim()) {
      if (field.required) errors.push(`${field.label} مطلوب`)
      continue
    }
    const trimmed = value.trim()
    if (trimmed.length > 300) errors.push(`${field.label} طويل جداً`)
    else clean[field.key] = trimmed
  }

  return { ok: errors.length === 0, errors, clean }
}

/**
 * Builds a live connection probe, or returns null when no Sandbox/Production
 * base URL is configured yet. Header templates like '${apiToken}' are resolved
 * here on the server; the returned object is never logged.
 */
export function buildProbeRequest(provider, credentials, environment, env = process.env) {
  if (!provider?.probe) return null
  if (!isEnvironment(environment)) return null

  const variable = `SHIPPING_${provider.code.toUpperCase()}_${environment.toUpperCase()}_BASE_URL`
  const base = String(env[variable] || '').trim()
  if (!base) return null

  let url
  try {
    const baseUrl = new URL(base)
    const path = provider.probe.path || '/'
    url = path === '/' ? baseUrl : new URL(path, baseUrl)
  } catch {
    return null
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null

  const headers = {}
  for (const [name, template] of Object.entries(provider.probe.headers || {})) {
    headers[name] = String(template).replace(/\$\{(\w+)\}/g, (_, key) => String(credentials?.[key] ?? ''))
  }

  const timeout = Number(env.SHIPPING_PROBE_TIMEOUT_MS)
  return {
    url: url.toString(),
    method: provider.probe.method || 'GET',
    headers,
    timeoutMs: Number.isFinite(timeout) && timeout >= 1000 && timeout <= 30000 ? timeout : 8000,
  }
}

/** Metadata sanity used by tests so a new provider cannot ship half-defined. */
export function registryIssues() {
  const issues = []
  for (const provider of listProviders()) {
    if (!PROVIDER_CODE_PATTERN.test(provider.code)) issues.push(`${provider.code}: bad code`)
    if (!provider.label || !provider.platform) issues.push(`${provider.code}: missing label`)
    if (!provider.credentialFields?.length) issues.push(`${provider.code}: no credential fields`)
    if (!credentialHintField(provider)) issues.push(`${provider.code}: no hint field`)
    if (!provider.capabilities || provider.capabilities.test !== true) issues.push(`${provider.code}: no test capability`)
    for (const field of provider.credentialFields) {
      if (!/^[a-zA-Z][a-zA-Z0-9]*$/.test(field.key)) issues.push(`${provider.code}: bad field ${field.key}`)
    }
  }
  return issues
}
