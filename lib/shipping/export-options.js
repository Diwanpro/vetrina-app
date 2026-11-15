// Client-safe fallback templates for «تصدير الشحنات (CSV)».
//
// P4 hid the whole button when no bulk/both connection was enabled, so a fresh
// demo store got NO response at all. P5 keeps the drawer openable: the registry
// supplies Yalidine + both ZR platforms even before a connection exists. The
// actual export still goes through the authenticated gateway, which refuses
// inactive links with a clear Arabic hint.

import { listProviders } from './registry.js'

export const DEFAULT_EXPORT_ENVIRONMENT = 'sandbox'

export function environmentLabel(environment) {
  return environment === 'sandbox' ? 'Sandbox' : 'الإنتاج'
}

/**
 * @param {{ storeId: string, storeName?: string, environment?: string }} options
 * @returns {Array<{ value: string, label: string, description: string, requiresConnection: boolean }>}
 */
export function fallbackExportTemplates({
  storeId,
  storeName = 'الفرع الحالي',
  environment = DEFAULT_EXPORT_ENVIRONMENT,
  providers = listProviders(),
} = {}) {
  if (!storeId) return []
  return providers
    .filter(provider => provider?.capabilities?.bulkTemplate)
    .map(provider => ({
      value: `${provider.code}:${environment}:${storeId}`,
      label: `${provider.label} · ${storeName} · ${environmentLabel(environment)}`,
      description: `قالب ${provider.label} · CSV (يتطلب تفعيل الربط)`,
      requiresConnection: true,
    }))
}

export function enabledTemplateValues(templates) {
  return new Set((templates || []).map(template => template.value))
}
