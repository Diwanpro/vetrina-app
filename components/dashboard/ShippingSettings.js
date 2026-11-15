'use client'

// P2: "ربط شركات التوصيل" tab. The browser holds plaintext keys only while the
// owner is typing; they are posted once over the authenticated HTTPS request to
// /api/shipping/connections, encrypted on the server, and never returned. The
// form reads only masked fields (credentials_hint) from the gateway.

import { useCallback, useEffect, useState } from 'react'
import { useDashboardSession } from '@/components/dashboard/SessionProvider'
import { Notice, fieldClass, primaryClass, secondaryClass } from '@/components/dashboard/EngineUI'
import CustomSelect from '@/components/ui/CustomSelect'
import SearchableSelect from '@/components/ui/SearchableSelect'
import { supabase } from '@/lib/supabase'
import { listProviders, getProvider, validateCredentials } from '@/lib/shipping/registry'
import { WILAYAS } from '@/lib/wilayas'

const ENV_OPTIONS = [
  { value: 'sandbox', label: 'بيئة الاختبار (Sandbox)' },
  { value: 'production', label: 'الإنتاج (Production)' },
]
const MODE_OPTIONS = [
  { value: 'api', label: 'ربط مباشر عبر API' },
  { value: 'bulk', label: 'تصدير بالجملة (CSV)' },
  { value: 'both', label: 'الاثنان معاً' },
]
const DELIVERY_OPTIONS = [
  { value: 'home', label: 'توصيل إلى العنوان' },
  { value: 'stopdesk', label: 'استلام من نقطة Stop Desk' },
]
const WILAYA_OPTIONS = WILAYAS.map(wilaya => ({
  value: wilaya.code,
  label: `${wilaya.code} — ${wilaya.name}`,
}))

function emptyForm(provider) {
  return {
    environment: 'sandbox',
    mode: 'api',
    enabled: true,
    originWilayaCode: '',
    deliveryType: 'home',
    autoShip: false,
    stopDeskId: '',
    credentials: Object.fromEntries(provider.credentialFields.map(field => [field.key, ''])),
    changeCredentials: true,
  }
}

function formFromConnection(provider, connection) {
  const base = emptyForm(provider)
  const defaults = connection?.defaults && typeof connection.defaults === 'object' ? connection.defaults : {}
  return {
    ...base,
    environment: connection?.environment || 'sandbox',
    mode: connection?.mode || 'api',
    enabled: connection?.enabled !== false,
    originWilayaCode: connection?.origin_wilaya_code || '',
    deliveryType: defaults.deliveryType === 'stopdesk' ? 'stopdesk' : 'home',
    autoShip: defaults.autoShip === true,
    stopDeskId: typeof defaults.stopDeskId === 'string' ? defaults.stopDeskId : '',
    changeCredentials: !connection,
  }
}

function formatDate(value) {
  if (!value) return ''
  try {
    return new Intl.DateTimeFormat('ar-DZ', { dateStyle: 'short', timeStyle: 'short' }).format(new Date(value))
  } catch {
    return ''
  }
}

export default function ShippingSettings() {
  const ctx = useDashboardSession()
  const allowed = Boolean(ctx && ['owner', 'manager'].includes(ctx.role) && ctx.storeId && !ctx.offline)
  const [connections, setConnections] = useState([])
  const [forms, setForms] = useState(() => Object.fromEntries(listProviders().map(provider => [provider.code, emptyForm(provider)])))
  const [tests, setTests] = useState({})
  const [busy, setBusy] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')

  async function authFetch(path, options = {}) {
    const { data, error: sessionError } = await supabase.auth.getSession()
    if (sessionError || !data?.session?.access_token) throw new Error('انتهت الجلسة، سجّل الدخول مجدداً.')
    const response = await fetch(path, {
      ...options,
      cache: 'no-store',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${data.session.access_token}`,
        ...(options.headers || {}),
      },
    })
    const body = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(body.error || `تعذر إكمال الطلب (${response.status})`)
    return body
  }

  const load = useCallback(async () => {
    if (!allowed || !ctx?.storeId) return
    setLoading(true)
    try {
      const body = await authFetch(`/api/shipping/connections?storeId=${encodeURIComponent(ctx.storeId)}`)
      const rows = Array.isArray(body.connections) ? body.connections : []
      setConnections(rows)
      setForms(previous => {
        const next = { ...previous }
        for (const provider of listProviders()) {
          const environment = previous[provider.code]?.environment || 'sandbox'
          const connection = rows.find(row => row.provider_code === provider.code && row.environment === environment)
          next[provider.code] = { ...formFromConnection(provider, connection), environment }
        }
        return next
      })
      setError('')
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }, [allowed, ctx?.storeId])

  useEffect(() => {
    if (allowed && ctx?.storeId) load()
  }, [allowed, ctx?.storeId, load])

  function setField(providerCode, patch) {
    setForms(previous => {
      const provider = getProvider(providerCode)
      const current = previous[providerCode] || emptyForm(provider)
      let next = { ...current, ...patch }
      if (patch.environment && patch.environment !== current.environment) {
        const connection = connections.find(row => row.provider_code === providerCode && row.environment === patch.environment)
        next = { ...formFromConnection(provider, connection), environment: patch.environment }
      }
      return { ...previous, [providerCode]: next }
    })
    setTests(previous => ({ ...previous }))
  }

  function setCredential(providerCode, key, value) {
    setForms(previous => {
      const current = previous[providerCode] || emptyForm(getProvider(providerCode))
      return {
        ...previous,
        [providerCode]: { ...current, credentials: { ...current.credentials, [key]: value } },
      }
    })
  }

  function connectionFor(providerCode, environment) {
    return connections.find(row => row.provider_code === providerCode && row.environment === environment) || null
  }

  async function save(provider) {
    const form = forms[provider.code] || emptyForm(provider)
    const key = `${provider.code}:${form.environment}`
    setBusy(`save:${key}`)
    setError('')
    setSuccess('')
    try {
      const payload = {
        storeId: ctx.storeId,
        providerCode: provider.code,
        environment: form.environment,
        mode: form.mode,
        enabled: form.enabled,
        originWilayaCode: form.originWilayaCode || null,
        defaults: {
          deliveryType: form.deliveryType,
          autoShip: form.autoShip,
          stopDeskId: form.stopDeskId.trim(),
        },
      }
      if (form.mode !== 'bulk' && form.changeCredentials) {
        const check = validateCredentials(provider, form.credentials, form.mode)
        if (!check.ok) throw new Error(check.errors.join(' · '))
        payload.credentials = form.credentials
      }
      await authFetch('/api/shipping/connections', { method: 'POST', body: JSON.stringify(payload) })
      setSuccess(`تم حفظ إعدادات ${provider.label} · ${form.environment === 'sandbox' ? 'Sandbox' : 'الإنتاج'}.`)
      setForms(previous => ({
        ...previous,
        [provider.code]: {
          ...previous[provider.code],
          credentials: emptyForm(provider).credentials,
          changeCredentials: false,
        },
      }))
      await load()
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy('')
    }
  }

  async function test(provider) {
    const form = forms[provider.code] || emptyForm(provider)
    const key = `${provider.code}:${form.environment}`
    setBusy(`test:${key}`)
    setError('')
    setSuccess('')
    try {
      const payload = {
        storeId: ctx.storeId,
        providerCode: provider.code,
        environment: form.environment,
        mode: form.mode,
      }
      if (form.mode !== 'bulk' && form.changeCredentials) {
        const check = validateCredentials(provider, form.credentials, form.mode)
        if (!check.ok) throw new Error(check.errors.join(' · '))
        payload.credentials = form.credentials
      }
      const body = await authFetch('/api/shipping/test', { method: 'POST', body: JSON.stringify(payload) })
      setTests(previous => ({ ...previous, [key]: body.result }))
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy('')
    }
  }

  async function disable(provider) {
    const form = forms[provider.code] || emptyForm(provider)
    const key = `${provider.code}:${form.environment}`
    setBusy(`disable:${key}`)
    setError('')
    setSuccess('')
    try {
      await authFetch('/api/shipping/connections', {
        method: 'DELETE',
        body: JSON.stringify({
          storeId: ctx.storeId,
          providerCode: provider.code,
          environment: form.environment,
        }),
      })
      setSuccess(`تم تعطيل ربط ${provider.label} ومسح المفاتيح المحفوظة.`)
      await load()
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy('')
    }
  }

  if (!allowed) {
    return (
      <p className="rounded-lg border border-amber-700/30 bg-amber-950/10 p-3 text-sm text-amber-200">
        إعدادات الربط متاحة للمالك أو المدير فقط، وتتطلب فرعاً محدداً واتصالاً بالإنترنت.
      </p>
    )
  }

  return (
    <div className="space-y-4">
      <Notice error={error} success={success} />

      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-neutral-500">
          المفاتيح تُشفّر على السيرفر بـ AES-256-GCM ولا تُعرض بعد الحفظ · لكل فرع وبيئة إعداد منفصل.
        </p>
        <button type="button" onClick={load} disabled={loading || Boolean(busy)} className={`${secondaryClass} min-h-9 px-3 text-xs`}>
          {loading ? 'جاري التحديث...' : 'تحديث'}
        </button>
      </div>

      {listProviders().map(provider => {
        const form = forms[provider.code] || emptyForm(provider)
        const connection = connectionFor(provider.code, form.environment)
        const key = `${provider.code}:${form.environment}`
        const result = tests[key]
        const needsKeys = form.mode !== 'bulk'
        const showInputs = needsKeys && form.changeCredentials
        const storeName = ctx.stores?.find(store => store.id === ctx.storeId)?.name || ''

        return (
          <section key={provider.code} className="rounded-xl border border-white/10 bg-black/20 p-4">
            <div className="mb-3 flex flex-wrap items-start justify-between gap-2">
              <div className="min-w-0">
                <h3 className="text-sm font-medium text-neutral-100">{provider.label}</h3>
                <p className="text-[11px] text-neutral-500">
                  {provider.platform} · {storeName || 'الفرع الحالي'}
                </p>
              </div>
              <span className={`rounded-full border px-2 py-0.5 text-[10px] ${
                connection?.enabled
                  ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-200'
                  : connection
                    ? 'border-amber-500/30 bg-amber-500/10 text-amber-200'
                    : 'border-white/15 bg-white/5 text-neutral-400'
              }`}>
                {connection ? (connection.enabled ? 'مفعّل' : 'معطّل') : 'غير مضبوط'}
              </span>
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <div className="block text-xs text-neutral-300">
                <CustomSelect
                  label="البيئة"
                  value={form.environment}
                  onChange={value => setField(provider.code, { environment: value })}
                  options={ENV_OPTIONS}
                  className="mt-1"
                />
              </div>
              <div className="block text-xs text-neutral-300">
                <CustomSelect
                  label="الاستراتيجية"
                  value={form.mode}
                  onChange={value => setField(provider.code, { mode: value })}
                  options={MODE_OPTIONS}
                  className="mt-1"
                />
              </div>
              <div className="block text-xs text-neutral-300">
                <span className="mb-1 block">
                  ولاية الانطلاق {provider.originWilayaRequired && needsKeys ? <span className="text-gold">*</span> : null}
                </span>
                <SearchableSelect
                  value={form.originWilayaCode}
                  onChange={value => setField(provider.code, { originWilayaCode: value })}
                  options={WILAYA_OPTIONS}
                  allowCreate={false}
                  placeholder="— اختر الولاية —"
                  emptyText="لا توجد ولاية بهذا الاسم"
                  aria-label="ولاية الانطلاق"
                />
              </div>
              <div className="block text-xs text-neutral-300">
                <CustomSelect
                  label="نوع التسليم الافتراضي"
                  value={form.deliveryType}
                  onChange={value => setField(provider.code, { deliveryType: value })}
                  options={DELIVERY_OPTIONS}
                  className="mt-1"
                />
              </div>
            </div>

            {needsKeys && (
              <div className="mt-3 space-y-2">
                {connection?.credentials_hint && (
                  <label className="flex flex-wrap items-center gap-2 text-xs text-neutral-400">
                    <input
                      type="checkbox"
                      checked={form.changeCredentials}
                      onChange={event => setField(provider.code, { changeCredentials: event.target.checked })}
                      className="h-4 w-4 accent-[#D4AF37]"
                    />
                    إدخال مفاتيح جديدة · المحفوظة: <span dir="ltr" className="text-gold">{connection.credentials_hint}</span>
                  </label>
                )}
                {showInputs ? (
                  <div className="grid gap-2 sm:grid-cols-2">
                    {provider.credentialFields.map(field => (
                      <label key={field.key} className="block text-xs text-neutral-300">{field.label}
                        <input
                          type={field.secret ? 'password' : 'text'}
                          value={form.credentials[field.key] || ''}
                          onChange={event => setCredential(provider.code, field.key, event.target.value)}
                          autoComplete="new-password"
                          spellCheck={false}
                          dir="ltr"
                          placeholder={field.placeholder || ''}
                          className={`${fieldClass} mt-1 text-start`}
                        />
                      </label>
                    ))}
                  </div>
                ) : (
                  <p className="text-[11px] text-neutral-500">المفاتيح محفوظة ومشفّرة على السيرفر؛ لا تُعرض بعد الحفظ.</p>
                )}
              </div>
            )}

            <div className="mt-3 flex flex-wrap items-center gap-4 text-xs text-neutral-400">
              <label className="flex items-center gap-2">
                <input type="checkbox" checked={form.enabled} onChange={event => setField(provider.code, { enabled: event.target.checked })} className="h-4 w-4 accent-[#D4AF37]" />
                تفعيل الربط
              </label>
              <label className="flex items-center gap-2">
                <input type="checkbox" checked={form.autoShip} onChange={event => setField(provider.code, { autoShip: event.target.checked })} className="h-4 w-4 accent-[#D4AF37]" />
                شحن تلقائي عند تأكيد الطلب (P3)
              </label>
              {form.deliveryType === 'stopdesk' && (
                <label className="flex min-w-0 flex-1 items-center gap-2">
                  معرّف النقطة
                  <input dir="ltr" value={form.stopDeskId} onChange={event => setField(provider.code, { stopDeskId: event.target.value })} placeholder="اختياري" className={`${fieldClass} min-w-0 flex-1`} />
                </label>
              )}
            </div>

            <div className="mt-4 flex flex-wrap gap-2">
              <button type="button" disabled={Boolean(busy)} onClick={() => save(provider)} className={primaryClass}>
                {busy === `save:${key}` ? 'جاري الحفظ...' : 'حفظ الإعدادات'}
              </button>
              <button type="button" disabled={Boolean(busy)} onClick={() => test(provider)} className={`${secondaryClass} text-xs`}>
                {busy === `test:${key}` ? 'جاري الاختبار...' : 'اختبار الاتصال'}
              </button>
              {connection && (
                <button type="button" disabled={Boolean(busy)} onClick={() => disable(provider)} className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-200 disabled:opacity-50">
                  {busy === `disable:${key}` ? 'جاري التعطيل...' : 'تعطيل ومسح المفاتيح'}
                </button>
              )}
            </div>

            {result && (
              <div className={`mt-3 rounded-lg border p-2.5 text-xs leading-relaxed ${
                result.ok ? 'border-emerald-700/30 bg-emerald-950/10 text-emerald-200' : 'border-red-800/40 bg-red-950/20 text-red-200'
              }`} role="status">
                <span className="font-medium">{result.ok ? '✓ نجح الاختبار' : '✗ فشل الاختبار'}</span>
                <span className="mx-2 text-neutral-500">·</span>
                <span>{result.mode === 'live' ? 'فحص فعلي' : 'تحقق محلي'}</span>
                {result.httpStatus != null && <span className="ms-2 text-neutral-400" dir="ltr">HTTP {result.httpStatus}</span>}
                {result.latencyMs != null && <span className="ms-2 text-neutral-400" dir="ltr">{result.latencyMs} ms</span>}
                <p className="mt-1 text-neutral-300">{result.message}</p>
              </div>
            )}

            {connection?.last_test_at && (
              <p className="mt-2 text-[11px] text-neutral-500">
                آخر اختبار: {formatDate(connection.last_test_at)} · {connection.last_test_ok ? 'ناجح' : 'فشل'} ({connection.last_test_mode || 'local'})
              </p>
            )}

            <p className="mt-3 border-t border-white/5 pt-2 text-[11px] leading-relaxed text-neutral-600">
              هذه المرحلة تضبط المفاتيح وتختبر الاتصال فقط. محوّل الإنشاء/التتبّع/البورْدورو يُفعّل في P3، والتصدير بالجملة في P4.
            </p>
          </section>
        )
      })}
    </div>
  )
}
