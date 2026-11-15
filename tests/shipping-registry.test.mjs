import test from 'node:test'
import assert from 'node:assert/strict'
import {
  PROVIDERS, listProviders, getProvider, credentialHintField,
  validateCredentials, buildProbeRequest, registryIssues,
} from '../lib/shipping/registry.js'

test('the registry is complete and every provider satisfies the shared contract', () => {
  assert.deepEqual(registryIssues(), [])
  assert.equal(listProviders().length, 3)
  assert.deepEqual(listProviders().map(provider => provider.code), ['yalidine', 'zrexpress', 'zrexpressnew'])
  assert.equal(getProvider('YALIDINE')?.code, 'yalidine')
  assert.equal(getProvider('unknown'), null)
  assert.equal(PROVIDERS.yalidine.originWilayaRequired, true)
  assert.equal(credentialHintField(getProvider('yalidine')).key, 'apiToken')
})

test('P4 capability flags are declared for every courier and CSV template', () => {
  const liveCapabilities = ['create', 'track', 'label', 'cancel', 'webhook', 'pullStatuses']
  for (const provider of listProviders()) {
    assert.equal(provider.capabilities.test, true)
    for (const flag of [...liveCapabilities, 'bulkTemplate', 'fees']) {
      assert.equal(typeof provider.capabilities[flag], 'boolean', `${provider.code}.${flag}`)
      // P4 ships all three adapters with full mock capabilities and CSV
      // templates. Fee tables are still outside scope.
      const expected = flag !== 'fees'
      assert.equal(provider.capabilities[flag], expected, `${provider.code}.${flag}`)
    }
  }
})

test('API credentials are validated, bulk-only connections need no keys', () => {
  const yalidine = getProvider('yalidine')
  assert.equal(validateCredentials(yalidine, {}, 'api').ok, false)
  assert.match(validateCredentials(yalidine, {}, 'api').errors.join(' '), /API ID/)
  const good = validateCredentials(yalidine, { apiId: ' id-1 ', apiToken: ' tok-1 ' }, 'api')
  assert.equal(good.ok, true)
  assert.deepEqual(good.clean, { apiId: 'id-1', apiToken: 'tok-1' })
  assert.equal(validateCredentials(yalidine, { apiId: 'x', apiToken: 'y', injected: 'z' }, 'api').ok, false)
  assert.equal(validateCredentials(yalidine, null, 'bulk').ok, true)
  assert.deepEqual(validateCredentials(yalidine, null, 'bulk').clean, {})
  assert.equal(validateCredentials(yalidine, {}, 'nonsense').ok, false)
})

test('the live probe is opt-in and never assumes an undocumented endpoint', () => {
  const yalidine = getProvider('yalidine')
  const credentials = { apiId: 'ID-7', apiToken: 'TOK-9' }
  assert.equal(buildProbeRequest(yalidine, credentials, 'sandbox', {}), null)
  assert.equal(buildProbeRequest(yalidine, credentials, 'nonsense', {}), null)

  const probe = buildProbeRequest(yalidine, credentials, 'sandbox', {
    SHIPPING_YALIDINE_SANDBOX_BASE_URL: 'https://sandbox.example.test/v1',
    SHIPPING_PROBE_TIMEOUT_MS: '4500',
  })
  assert.equal(probe.url, 'https://sandbox.example.test/v1')
  assert.equal(probe.method, 'GET')
  assert.equal(probe.timeoutMs, 4500)
  assert.equal(probe.headers['X-API-ID'], 'ID-7')
  assert.equal(probe.headers['X-API-TOKEN'], 'TOK-9')
  assert.doesNotMatch(JSON.stringify(probe.headers), /\$\{/)

  // A javascript: or malformed base URL must never reach fetch().
  assert.equal(buildProbeRequest(yalidine, credentials, 'sandbox', {
    SHIPPING_YALIDINE_SANDBOX_BASE_URL: 'javascript:alert(1)',
  }), null)
  assert.equal(buildProbeRequest(yalidine, credentials, 'sandbox', {
    SHIPPING_YALIDINE_SANDBOX_BASE_URL: 'not a url',
  }), null)
})

test('ZR platform variants carry distinct credential sets and headers', () => {
  const procolis = buildProbeRequest(getProvider('zrexpress'), { token: 'T', key: 'K' }, 'production', {
    SHIPPING_ZREXPRESS_PRODUCTION_BASE_URL: 'https://procolis.example.test',
  })
  const modern = buildProbeRequest(getProvider('zrexpressnew'), { apiKey: 'A', tenantId: 'TT' }, 'sandbox', {
    SHIPPING_ZREXPRESSNEW_SANDBOX_BASE_URL: 'https://zrexpress.example.test',
  })
  assert.equal(procolis.headers.Authorization, 'Token T')
  assert.equal(procolis.headers['X-Api-Key'], 'K')
  assert.equal(modern.headers['X-Tenant'], 'TT')
  assert.equal(modern.headers['X-Api-Key'], 'A')
})
