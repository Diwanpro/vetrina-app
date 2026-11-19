// Invoke the actual Next route + Supabase SDK. Only the upstream HTTP transport
// is a fixture. No Live requests, real keys, fixture uploads or database writes.
import test, { afterEach } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const out = path.resolve('.cache/storefront-content-api/route.mjs')
await build({ entryPoints: ['app/api/store/[slug]/content/route.js'], outfile: out, bundle: true, platform: 'node', format: 'esm',
  external: ['@supabase/supabase-js'], alias: { 'server-only': path.resolve('node_modules/next/dist/compiled/server-only/empty.js') } })
const { GET } = await import(pathToFileURL(out))
const origin = 'https://fixture.invalid', anon = 'fixture-visitor', signer = 'fixture-signer-never-serialize'
const settings = { NEXT_PUBLIC_SUPABASE_URL: origin, NEXT_PUBLIC_SUPABASE_ANON_KEY: anon, SUPABASE_SERVICE_ROLE_KEY: signer }
const actual = Object.fromEntries(Object.keys(settings).map(k => [k, process.env[k]])), actualFetch = globalThis.fetch
const id = n => `00000000-0000-4000-b000-${String(n).padStart(12, '0')}`
const enabled = { slug: 'flower-shop', store_id: id(2), tenant_id: id(1) }, other = id(3)
const prefix = `${enabled.tenant_id}/${enabled.store_id}/`, bucket = 'storefront-assets'
const row = (n, patch = {}) => ({ id: id(n), title: `عنوان ${n}`, status: 'published', sort_order: n,
  image_url: `${prefix}${n}.webp`, link_url: null, store_id: enabled.store_id, tenant_id: enabled.tenant_id, ...patch })
const signed = key => `${origin}/storage/v1/object/sign/${bucket}/${key}?token=fixture`
const upstreamError = () => Response.json({ message: `detail containing ${signer}` }, { status: 403 })
const empty = { banners: [], sections: [] }
let unexpected
function fixture({ banners = [], sections = [], lookup = enabled, unfiltered = false, intercept } = {}) {
  Object.assign(process.env, settings); unexpected = []
  const rpc = [], reads = [], signs = []
  globalThis.fetch = async (input, init) => {
    const u = new URL(input), headers = new Headers(init.headers), key = headers.get('apikey')
    const c = { u, method: init.method, body: init.body && JSON.parse(init.body), key }
    // Collect unexpected calls even if the route correctly swallows an error.
    if (u.origin !== origin || headers.has('cookie') || headers.get('authorization') !== `Bearer ${key}` || init.cache !== 'no-store' || init.redirect !== 'error') unexpected.push(`upstream context: ${u.pathname}`)
    const rpcPath = '/rest/v1/rpc/get_store_by_slug', signPath = `/storage/v1/object/sign/${bucket}`
    if (u.pathname === rpcPath && c.method === 'POST' && key === anon) {
      rpc.push(c); return (await intercept?.(c)) || Response.json(c.body.p_slug === enabled.slug ? lookup : null)
    }
    const table = { '/rest/v1/storefront_banners': banners, '/rest/v1/storefront_sections': sections }[u.pathname]
    if (table && c.method === 'GET' && key === anon) {
      reads.push(c); const response = await intercept?.(c); if (response) return response
      let rows = table.slice()
      if (!unfiltered) {
        for (const field of ['tenant_id', 'store_id', 'status']) if (u.searchParams.has(field)) rows = rows.filter(r => `eq.${r[field]}` === u.searchParams.get(field))
        rows.sort((a, b) => a.sort_order - b.sort_order || a.id.localeCompare(b.id))
      }
      return Response.json(rows.slice(0, Number(u.searchParams.get('limit') || 1000)))
    }
    if (u.pathname === signPath && c.method === 'POST' && key === signer) {
      signs.push(c); return (await intercept?.(c)) || Response.json(c.body.paths.map(key => ({ path: key, signedURL: `/object/sign/${bucket}/${key}?token=fixture` })))
    }
    unexpected.push(`${c.method} ${u.pathname} with ${key}`); return upstreamError()
  }
  return { rpc, reads, signs, paths: () => signs.flatMap(c => c.body.paths) }
}
afterEach(() => {
  globalThis.fetch = actualFetch
  for (const [k, value] of Object.entries(actual)) { if (value === undefined) delete process.env[k]; else process.env[k] = value }
  assert.deepEqual(unexpected, [])
})
async function get(slug = enabled.slug, search = '') {
  const req = new Request(`https://shop.test/api/store/${encodeURIComponent(slug)}/content${search}`, { headers: {
    Cookie: 'private-merchant=session', Authorization: 'Bearer untrusted-dashboard-session',
  } })
  const res = await GET(req, { params: Promise.resolve({ slug }) }); assert.match(res.headers.get('cache-control'), /no-store/)
  const body = await res.json(); assert.ok(!JSON.stringify(body).includes(signer)); return { status: res.status, body }
}

test('enabled slug: anon scopes and orders both tables; only Storage uses the privileged key, for exactly 300 seconds', async () => {
  const a = row(10, { link_url: '/journal', sort_order: 1 }), b = row(11, { link_url: 'https://example.test/look', sort_order: 0 })
  const f = fixture({ banners: [a, row(12, { status: 'draft' }), b, row(13, { store_id: other })], sections: [row(14, { tenant_id: other }), row(15)] })
  const result = await get('FLOWER-SHOP'); assert.equal(result.status, 200); assert.deepEqual(f.rpc[0].body, { p_slug: enabled.slug })
  assert.equal(f.reads.length, 2)
  for (const { u } of f.reads) {
    assert.equal(u.searchParams.get('status'), 'eq.published'); assert.equal(u.searchParams.get('store_id'), `eq.${enabled.store_id}`)
    assert.equal(u.searchParams.get('tenant_id'), `eq.${enabled.tenant_id}`); assert.equal(u.searchParams.get('order'), 'sort_order.asc,id.asc')
    assert.notEqual(u.searchParams.get('select'), '*'); assert.ok(Number(u.searchParams.get('limit')) > 0)
  }
  assert.deepEqual(new Set(f.paths()), new Set([a.image_url, b.image_url, row(15).image_url]))
  assert.ok(f.signs.every(c => c.body.expiresIn === 300))
  const dto = r => ({ id: r.id, title: r.title, imageUrl: signed(r.image_url), href: r.link_url })
  assert.deepEqual(result.body, { banners: [dto(b), dto(a)], sections: [dto(row(15))] })
})

test('never mints or returns a URL for a draft-only object; publishing enables issuance and unpublishing stops renewal', async () => {
  const b = row(10, { status: 'draft' }), s = row(20, { status: 'draft' }), f = fixture({ banners: [b], sections: [s] })
  assert.deepEqual((await get()).body, empty); assert.equal(f.signs.length, 0)
  s.status = 'published'; assert.equal((await get()).body.sections[0].imageUrl, signed(s.image_url)); assert.deepEqual(f.paths(), [s.image_url])
  s.status = 'draft'; assert.deepEqual((await get()).body, empty); assert.deepEqual(f.paths(), [s.image_url], 'no new token after withdrawal')
})

test('at the signing boundary even an over-broad read cannot authorize drafts, foreign rows or out-of-scope keys', async () => {
  const b = row(10), keys = [null, `${id(9)}/${enabled.store_id}/x.png`, `${enabled.tenant_id}/${other}/x.png`,
    'https://outside.test/x.png', `${prefix}nested/x.png`, `${prefix}../x.png`, `${prefix}x%2Fy.png`, `${prefix}a.svg`, `${prefix}a.png?token=old`]
  const f = fixture({ unfiltered: true, banners: [b, row(11, { image_url: b.image_url }), row(12, { status: 'draft' }),
    row(13, { tenant_id: other }), row(14, { store_id: other }), ...keys.map((image_url, i) => row(100 + i, { image_url }))] })
  assert.deepEqual((await get()).body.banners.map(r => r.id), [b.id, id(11)]); assert.deepEqual(f.paths(), [b.image_url], 'sign the allowed key only once')
})

test('missing/disabled shop or mismatched identity: no content reads and no signing', async () => {
  for (const lookup of [null, { ...enabled, slug: 'another-shop' }, { ...enabled, tenant_id: null }, { ...enabled, store_id: 'invalid' }]) {
    const f = fixture({ lookup, banners: [row(10)] }); assert.deepEqual(await get(), { status: 404, body: empty }); assert.equal(f.reads.length + f.signs.length, 0)
  }
})

test('the endpoint accepts only a valid slug, never a caller-supplied object, bucket, tenant or branch', async () => {
  const f = fixture({ banners: [row(10)] })
  for (const query of ['?path=arbitrary.png', '?bucket=else', `?tenant_id=${other}&store_id=${other}`]) assert.equal((await get(enabled.slug, query)).status, 400)
  for (const bad of ['..', 'flower/shop', 'flower%2fshop', 'x'.repeat(64)]) assert.equal((await get(bad)).status, 404)
  assert.equal(f.rpc.length + f.reads.length + f.signs.length, 0)
})

test('unsafe links become inert cards without losing their images', async () => {
  const links = ['javascript:alert(1)', '//example.test', '/\\example.test', '/a\nb', 'data:text/plain,a', 'https:///broken', '/safe?q=1', 'https://example.test/path']
  fixture({ sections: links.map((link_url, i) => row(i + 10, { link_url })) })
  assert.deepEqual((await get()).body.sections.map(r => r.href), [null, null, null, null, null, null, links[6], links[7]])
})

for (const fail of ['read', 'sign']) test(`one failed ${fail} falls back independently; the other collection still renders`, async () => {
  const b = row(10), s = row(20)
  fixture({ banners: [b], sections: [s], intercept: c => (fail === 'read' ? c.u.pathname.endsWith('/storefront_banners') : c.body?.paths?.includes(b.image_url)) && upstreamError() })
  const { status, body } = await get(); assert.equal(status, 200); assert.deepEqual(body.banners, []); assert.equal(body.sections[0].imageUrl, signed(s.image_url))
})

test('a partial signing response is matched by approved path, not array position', async () => {
  const a = row(10), b = row(11)
  fixture({ banners: [a, b], intercept: c => c.body?.paths && Response.json([
    { path: b.image_url, signedURL: `/object/sign/${bucket}/${b.image_url}?token=fixture` },
    { path: 'unexpected', signedURL: '/not-requested' }, { path: a.image_url, error: 'not found', signedURL: null },
  ]) })
  const result = await get(); assert.deepEqual(result.body.banners.map(r => r.imageUrl), [signed(b.image_url)])
})

test('missing signing configuration or failed resolution never falls back to signing as anon or exposes upstream errors', async () => {
  const f = fixture({ banners: [row(10)], sections: [row(11)] }); delete process.env.SUPABASE_SERVICE_ROLE_KEY
  assert.deepEqual(await get(), { status: 503, body: empty }); assert.equal(f.signs.length, 0)
  const later = fixture({ intercept: () => upstreamError() }); assert.deepEqual(await get(), { status: 503, body: empty }); assert.equal(later.reads.length + later.signs.length, 0)
})
