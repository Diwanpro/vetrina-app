// Banner regression suite: real UI and authenticated client, isolated HTTP.
import test from 'node:test'
import assert from 'node:assert/strict'
import { dashboardContentFixture, act, screen, within, fireEvent, waitFor, id, tenant, branch, sibling, dir, bucket, sign, deferred, errorReply } from './fixtures/dashboard-content-ui.mjs'
const { route, table, row, mount, routeAllowed } = await dashboardContentFixture('banners', 'storefront_banners', 'بانر')
const btn = name => screen.getByRole('button', { name })
const openNew = () => fireEvent.click(btn('إضافة بانر جديد'))
const editFirst = async () => fireEvent.click(await screen.findByRole('button', { name: 'تعديل بانر بانر 10' }))
const change = (name, value) => fireEvent.change(screen.getByLabelText(name), { target: { value } })
const upload = file => fireEvent.change(screen.getByLabelText('صورة البانر'), { target: { files: [file] } })
const image = () => new File(['fixture'], 'اختبار/الأصل.gif', { type: 'image/webp' })
const save = () => fireEvent.click(btn('حفظ البانر'))
const paths = f => f.signs().flatMap(c => c.body.paths)
const scope = c => {
  assert.equal(c.params.get('tenant_id'), `eq.${tenant}`); assert.equal(c.params.get('store_id'), `eq.${branch}`)
}

for (const role of ['owner', 'manager']) test(`${role}: list is sorted and scoped in PostgREST, only current-branch images are signed`, async () => {
  const f = mount({ role })
  assert.ok(routeAllowed(role, route)); await screen.findByRole('img', { name: 'صورة بانر 10' })
  assert.deepEqual(screen.getAllByRole('heading', { level: 3 }).map(h => h.textContent), ['بانر 10', 'بانر 11'])
  for (const [n, label] of [[10, 'منشور'], [11, 'مسودة']]) {
    const card = within(screen.getByText(`بانر ${n}`).closest('li')); card.getByText(label); card.getByText(`الترتيب: ${n}`)
  }
  f.reads().forEach(scope); assert.equal(f.reads()[0].params.get('order'), 'sort_order.asc,id.asc')
  assert.equal(f.signs()[0].body.expiresIn, 300); assert.deepEqual(paths(f), [`${dir}10.png`, `${dir}11.png`]); assert.equal(f.writes().length, 0)
})
for (const [name, role, ctx] of [['employee', 'employee', {}], ['visitor', 'guest', {}], ['all branches', 'owner', { allBranches: true }],
  ['no user', 'owner', { user: null }], ['no tenant', 'owner', { tenantId: null }], ['unlisted branch', 'owner', { storeId: 'other' }], ['wrong assignment', 'manager', { storeId: sibling }], ['offline', 'owner', { offline: true }]]) {
  test(`direct URL: ${name} cannot load, sign or open the editor`, () => {
    const f = mount({ role, ctx }); if (['employee', 'guest'].includes(role)) assert.equal(routeAllowed(role, route), false)
    screen.getByRole('alert'); assert.ok(!screen.queryByRole('button')); assert.deepEqual(f.calls, [])
  })
}

test('new banner: upload on save only, generated branch key, persisted draft and no signed/public URL in row', async () => {
  const f = mount({ rows: [] }); await screen.findByText('لا توجد بانرات لهذا الفرع بعد.'); openNew()
  assert.ok(screen.getByRole('radio', { name: 'مسودة' }).checked)
  change('عنوان البانر', ' عرض جديد '); change('الترتيب', '3'); upload(image())
  assert.ok(screen.getByAltText('معاينة صورة البانر').src.startsWith('blob:')); assert.equal(f.uploads().length, 0); save()
  await screen.findByText('تمت إضافة البانر.'); const thumb = await screen.findByAltText('صورة عرض جديد')
  const [up] = f.uploads(), key = up.pathname.slice(bucket.length + 1)
  assert.equal(f.uploads().length, 1); assert.match(key.slice(dir.length), /^[0-9a-f-]{36}\.webp$/); assert.ok(key.startsWith(dir)); assert.equal(up.headers.get('x-upsert'), 'false')
  assert.deepEqual(f.writes().map(c => c.body), [{ tenant_id: tenant, store_id: branch, title: 'عرض جديد', sort_order: 3, status: 'draft', link_url: null, image_url: key }])
  assert.ok(thumb.src.includes(`/object/sign/storefront-assets/${key}?token=`)); assert.deepEqual(paths(f), [key])
})
test('editor uses and renews a signed preview; editing without a file preserves the key, updates only the matching id/tenant/store', async () => {
  const f = mount(); const old = (await screen.findByAltText('صورة بانر 10')).src; await editFirst()
  assert.equal(screen.getByAltText('معاينة صورة البانر').src, old)
  await act(async () => document.dispatchEvent(new Event('visibilitychange')))
  await waitFor(() => assert.notEqual(screen.getByAltText('معاينة صورة البانر').src, old))
  change('عنوان البانر', 'بعد التعديل'); change('الرابط (اختياري)', '/s/branch'); change('الترتيب', '0'); fireEvent.click(screen.getByRole('radio', { name: 'مسودة' })); save()
  await screen.findByText('تم تحديث البانر.'); await screen.findByText('بعد التعديل'); const [c] = f.writes(); scope(c)
  assert.equal(c.method, 'PATCH'); assert.equal(c.params.get('id'), `eq.${id(10)}`); assert.deepEqual(c.body, { title: 'بعد التعديل', status: 'draft', link_url: '/s/branch', sort_order: 0 }); assert.equal(f.uploads().length, 0)
})
test('replacing an image is local until saved; cancel is side-effect free and a confirmed edit signs the new key', async () => {
  const f = mount(); await screen.findByAltText('صورة بانر 10'); await editFirst(); upload(image()); fireEvent.click(btn('إلغاء'))
  assert.ok(!screen.queryByRole('dialog')); assert.equal(f.uploads().length, 0); assert.equal(f.writes().length, 0)
  await editFirst(); assert.ok(screen.getByAltText('معاينة صورة البانر').src.includes(`${dir}10.png?token=`)); upload(image()); save()
  await screen.findByText('تم تحديث البانر.'); const [write] = f.writes(), newKey = f.uploads()[0].pathname.slice(bucket.length + 1)
  scope(write); assert.equal(write.params.get('id'), `eq.${id(10)}`); assert.equal(write.body.image_url, newKey); assert.ok(newKey.startsWith(dir) && newKey.endsWith('.webp'))
  await waitFor(() => assert.ok(screen.getByAltText('صورة بانر 10').src.includes(`${newKey}?token=`)))
  assert.equal(f.calls.filter(c => c.method === 'DELETE').length, 0, 'the old object could be referenced elsewhere')
})
test('editor validates title, required image, MIME, size, link and integer order before uploading', async () => {
  const f = mount(); await screen.findByText('بانر 10'); openNew(); save(); await screen.findByText('أدخل عنوان البانر.'); change('عنوان البانر', 'جديد'); save(); await screen.findByText('اختر صورة للبانر.')
  upload(new File(['x'], 'x.png', { type: 'image/svg+xml' })); assert.match(screen.getByRole('alert').textContent, /JPEG/)
  const large = image(); Object.defineProperty(large, 'size', { value: 8388609 }); upload(large); assert.match(screen.getByRole('alert').textContent, /8/); upload(image())
  for (const value of ['//untrusted.test', 'javascript:alert(1)', '/\\outside', 'https:///invalid']) {
    change('الرابط (اختياري)', value); save(); await screen.findByText(/أدخل رابط HTTP/)
  }
  change('الرابط (اختياري)', 'https://example.test/banner'); change('الترتيب', '-1'); save(); await screen.findByText(/أدخل ترتيباً صحيحاً/)
  assert.equal(f.uploads().length, 0); assert.equal(f.writes().length, 0); change('الترتيب', '4'); fireEvent.click(screen.getByRole('radio', { name: 'منشور' })); save()
  await screen.findByText('تمت إضافة البانر.'); assert.equal(f.writes()[0].body.link_url, 'https://example.test/banner'); assert.equal(f.writes()[0].body.status, 'published')
})
test('upload failure does not write metadata, close the editor, or discard the existing asset', async () => {
  const f = mount({ intercept: c => c.pathname.startsWith(bucket + '/') && errorReply(403, 'denied') }); await editFirst(); upload(image()); save()
  await screen.findByText(/تعذر رفع الصورة/); screen.getByRole('dialog'); assert.equal(f.writes().length, 0); assert.equal(f.calls.filter(c => c.method === 'DELETE').length, 0)
})
test('a definite DB rejection cleans up only the newly uploaded key; zero matched rows never report success', async () => {
  let empty = false
  const f = mount({ intercept: c => c.method === 'PATCH' && (empty ? Response.json([]) : errorReply(403, '42501')) }); await editFirst(); upload(image()); save()
  await screen.findByText(/تعذر حفظ البانر/); const [up] = f.uploads(); const [removal] = f.calls.filter(c => c.method === 'DELETE'); assert.deepEqual(removal.body.prefixes, [up.pathname.slice(bucket.length + 1)])
  empty = true; save(); await screen.findByText(/لم يعد البانر متاحاً/); assert.ok(!screen.queryByText('تم تحديث البانر.'))
})
test('unconfirmed insert blocks repeat submit, retains the potentially committed object, and refreshes on close', async () => {
  const gate = deferred(), f = mount({ rows: [], intercept: c => c.pathname === table && c.method === 'POST' && gate.promise })
  await screen.findByText(/لا توجد بانرات لهذا الفرع/); openNew(); change('عنوان البانر', 'جديد'); upload(image()); save()
  assert.ok(btn('جاري الحفظ…').disabled); fireEvent.keyDown(window, { key: 'Escape' }); screen.getByRole('dialog')
  await act(async () => gate.resolve(errorReply(503, 'unconfirmed'))); await screen.findByText(/تعذر تأكيد الحفظ/); assert.ok(btn('حفظ البانر').disabled)
  assert.equal(f.writes().length, 1); assert.equal(f.calls.filter(c => c.method === 'DELETE').length, 0); fireEvent.click(btn('العودة إلى القائمة')); await screen.findByText(/لا توجد بانرات لهذا الفرع/); assert.equal(f.reads().length, 2)
})
test('changing branch during an upload unmounts the draft and does not issue a stale row write', async () => {
  const gate = deferred(), f = mount({ role: 'owner', intercept: c => c.pathname.startsWith(bucket + '/') && gate.promise }); await editFirst(); upload(image()); save()
  await waitFor(() => assert.equal(f.uploads().length, 1)); f.switchContext({ storeId: sibling }); await screen.findByText('بانر 12'); assert.ok(!screen.queryByRole('dialog'))
  await act(async () => gate.resolve(Response.json({ Id: id(99), Key: 'fixture' }))); assert.equal(f.writes().length, 0); assert.ok(!screen.queryByText('بانر 10')); assert.equal(f.reads().at(-1).params.get('store_id'), `eq.${sibling}`)
})
test('never signs an external URL or foreign branch key; missing previews do not prevent editing metadata', async () => {
  const f = mount({ rows: [row(10, { image_url: 'https://example.test/photo.jpg' }), row(11, { image_url: `${tenant}/${sibling}/wrong.png` }), row(12)], intercept: c => c.pathname === sign && errorReply(403, 'denied') })
  await screen.findByText('بانر 10'); await waitFor(() => assert.deepEqual(paths(f), [`${dir}12.png`])); assert.ok(!screen.queryByRole('img')); fireEvent.click(btn('تعديل بانر بانر 12')); change('عنوان البانر', 'عنوان'); save(); await screen.findByText('تم تحديث البانر.')
})
test('scoped pagination signs only visible rows, not the lookahead row', async () => {
  const f = mount({ rows: Array.from({ length: 21 }, (_, i) => row(100 + i)) }); await screen.findByAltText('صورة بانر 100'); assert.equal(f.signs()[0].body.paths.length, 20); assert.ok(!screen.queryByText('بانر 120'))
  fireEvent.click(btn('التالي')); await screen.findByAltText('صورة بانر 120'); assert.deepEqual(f.signs()[1].body.paths, [`${dir}120.png`]); assert.ok(btn('التالي').disabled)
  f.reads().forEach(scope); assert.equal(f.reads()[1].params.get('offset'), '20'); fireEvent.click(btn('السابق')); await screen.findByText('بانر 100')
})
