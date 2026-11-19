// Exercise SectionEditor and its page through the actual authenticated Supabase client.
// The transport intentionally knows nothing about banners, products or the public storefront.
import test from 'node:test'
import assert from 'node:assert/strict'
import { dashboardContentFixture, act, screen, within, fireEvent, waitFor, id, tenant, branch, sibling, foreign, dir, bucket, deferred, errorReply } from './fixtures/dashboard-content-ui.mjs'

const { route, table, row, mount, routeAllowed } = await dashboardContentFixture('sections', 'storefront_sections', 'قسم')
const button = name => screen.getByRole('button', { name })
const change = (label, value) => fireEvent.change(screen.getByLabelText(label), { target: { value } })
const click = name => fireEvent.click(button(name))
const selectImage = (file = new File(['image'], 'ملف التاجر.jpeg', { type: 'image/webp' })) =>
  fireEvent.change(screen.getByLabelText('صورة القسم'), { target: { files: [file] } })
const editFirst = async () => fireEvent.click(await screen.findByRole('button', { name: 'تعديل قسم قسم 10' }))
function scoped(request, store = branch) {
  assert.equal(request.pathname, table)
  assert.equal(request.params.get('store_id'), `eq.${store}`)
  assert.equal(request.params.get('tenant_id'), `eq.${tenant}`)
}

for (const role of ['owner', 'manager']) test(`${role} sees only selected-branch sections, in order, with private thumbnails`, async () => {
  const f = mount({ role })
  assert.equal(routeAllowed(role, route), true)
  screen.getByRole('heading', { level: 1, name: 'الأقسام التحريرية' })
  await screen.findByAltText('صورة قسم 10')
  assert.deepEqual(screen.getAllByRole('heading', { level: 3 }).map(h => h.textContent), ['قسم 10', 'قسم 11'])
  for (const [n, status] of [[10, 'منشور'], [11, 'مسودة']]) {
    const card = within(screen.getByText(`قسم ${n}`).closest('li'))
    card.getByText(status); card.getByText(`الترتيب: ${n}`)
  }
  scoped(f.reads()[0]); assert.equal(f.reads()[0].params.get('order'), 'sort_order.asc,id.asc')
  assert.deepEqual(f.signs()[0].body, { expiresIn: 300, paths: [`${dir}10.png`, `${dir}11.png`] })
  assert.ok(f.calls.every(c => c.headers.get('authorization') === 'Bearer fixture'))
})

for (const [reason, role, ctx] of [
  ['employee', 'employee', {}], ['unknown role', 'guest', {}], ['all branches', 'owner', { allBranches: true, storeId: null }],
  ['unlisted store', 'owner', { storeId: foreign }], ['another assignment', 'manager', { storeId: sibling }],
  ['no session', 'manager', { user: null }], ['offline', 'owner', { offline: true }],
]) test(`direct sections URL fails closed: ${reason}`, () => {
  const f = mount({ role, ctx })
  if (role === 'employee' || role === 'guest') assert.equal(routeAllowed(role, route), false)
  screen.getByRole('alert'); assert.ok(!screen.queryByRole('button')); assert.deepEqual(f.calls, [])
})

test('create a draft with a key only, then publish with a link; editing metadata signs but never re-uploads the image', async () => {
  const rows = [], f = mount({ rows })
  await screen.findByText('لا توجد أقسام لهذا الفرع بعد.'); click('إضافة قسم جديد')
  screen.getByRole('dialog', { name: 'إضافة قسم جديد' }); assert.ok(screen.getByRole('radio', { name: 'مسودة' }).checked)
  click('حفظ القسم'); await screen.findByText('أدخل عنوان القسم.')
  change('عنوان القسم', ' ألوان الشتاء '); click('حفظ القسم'); await screen.findByText('اختر صورة للقسم.')
  assert.equal(f.writes().length, 0); change('الترتيب', '7'); selectImage()
  assert.ok(screen.getByAltText('معاينة صورة القسم').src.startsWith('blob:')); assert.equal(f.uploads().length, 0)
  click('حفظ القسم'); await screen.findByText('تمت إضافة القسم.')
  const thumb = await screen.findByAltText('صورة ألوان الشتاء'), key = f.uploads()[0].pathname.slice(bucket.length + 1)
  assert.ok(key.startsWith(dir)); assert.match(key.slice(dir.length), /^[\da-f-]{36}\.webp$/)
  assert.equal(f.uploads()[0].headers.get('x-upsert'), 'false')
  assert.equal(f.writes()[0].method, 'POST'); assert.deepEqual(f.writes()[0].body, {
    tenant_id: tenant, store_id: branch, title: 'ألوان الشتاء', image_url: key, link_url: null, sort_order: 7, status: 'draft',
  })
  assert.ok(thumb.src.includes(`/object/sign/storefront-assets/${key}?token=`))
  click('تعديل قسم ألوان الشتاء'); screen.getByRole('dialog', { name: 'تعديل القسم' })
  const previousUrl = screen.getByAltText('معاينة صورة القسم').src; assert.equal(previousUrl, thumb.src)
  await act(async () => document.dispatchEvent(new Event('visibilitychange')))
  await waitFor(() => assert.notEqual(screen.getByAltText('معاينة صورة القسم').src, previousUrl))
  change('الرابط (اختياري)', '/summer'); change('الترتيب', '1'); fireEvent.click(screen.getByRole('radio', { name: 'منشور' })); click('حفظ القسم')
  await screen.findByText('تم تحديث القسم.'); await screen.findByText('منشور')
  const patch = f.writes()[1]; scoped(patch); assert.equal(patch.method, 'PATCH'); assert.equal(patch.params.get('id'), `eq.${rows[0].id}`)
  assert.deepEqual(patch.body, { title: 'ألوان الشتاء', link_url: '/summer', sort_order: 1, status: 'published' })
  assert.equal(f.writes().length, 2); assert.equal(f.uploads().length, 1)
})

test('validated replacement writes a new scoped key to the matching section only; cancelling does not upload', async () => {
  const f = mount(); await editFirst(); selectImage(); click('إلغاء'); assert.equal(f.uploads().length, 0)
  await editFirst(); selectImage(new File(['svg'], 'x.png', { type: 'image/svg+xml' })); screen.getByText(/اختر صورة بصيغة JPEG/)
  const large = new File(['x'], 'x.jpg', { type: 'image/jpeg' }); Object.defineProperty(large, 'size', { value: 8388609 })
  selectImage(large); screen.getByText(/أكبر من 8/); assert.ok(button('حفظ القسم').disabled)
  selectImage(); change('الرابط (اختياري)', '//other.test'); click('حفظ القسم'); await screen.findByText(/أدخل رابط HTTP/)
  change('الرابط (اختياري)', 'https://example.test/journal'); change('الترتيب', '-1'); click('حفظ القسم'); await screen.findByText(/أدخل ترتيباً صحيحاً/)
  assert.equal(f.uploads().length, 0); assert.equal(f.writes().length, 0)
  change('الترتيب', '0'); click('حفظ القسم'); await screen.findByText('تم تحديث القسم.')
  const patch = f.writes()[0], key = f.uploads()[0].pathname.slice(bucket.length + 1)
  scoped(patch); assert.equal(patch.params.get('id'), `eq.${id(10)}`); assert.equal(patch.body.image_url, key)
  assert.ok(key.startsWith(dir)); assert.notEqual(key, `${dir}10.png`)
  await waitFor(() => assert.ok(screen.getByAltText('صورة قسم 10').src.includes(`${key}?token=`)))
  assert.ok(f.calls.every(c => c.method !== 'DELETE'))
})

test('does not sign an external URL or another branch key, even if returned by the list', async () => {
  const f = mount({ rows: [row(10), row(11, { image_url: `${tenant}/${sibling}/x.png` }), row(12, { image_url: 'https://outside.test/thumb.jpg' })] })
  await screen.findByAltText('صورة قسم 10'); assert.deepEqual(f.signs()[0].body.paths, [`${dir}10.png`]); assert.equal(screen.getAllByRole('img').length, 1)
})

test('a policy rejection or zero affected rows is not a success and never widens the write scope', async () => {
  let denied = true
  const f = mount({ intercept: c => c.method === 'PATCH' && (denied ? errorReply(403, '42501') : Response.json([])) })
  await editFirst(); selectImage(); click('حفظ القسم'); await screen.findByText(/تعذر حفظ القسم/)
  const removed = f.calls.filter(c => c.method === 'DELETE'); assert.deepEqual(removed[0].body.prefixes, [f.uploads()[0].pathname.slice(bucket.length + 1)])
  denied = false; click('حفظ القسم'); await screen.findByText(/لم يعد القسم متاحاً/); screen.getByRole('dialog'); assert.ok(!screen.queryByText('تم تحديث القسم.'))
  for (const c of f.writes()) { scoped(c); assert.equal(c.params.get('id'), `eq.${id(10)}`) }
})

test('switching branch during an upload closes the editor and cancels the old-branch section write', async () => {
  const gate = deferred(), f = mount({ role: 'owner', intercept: c => c.pathname.startsWith(bucket + '/') && gate.promise })
  await editFirst(); selectImage(); click('حفظ القسم'); await waitFor(() => assert.equal(f.uploads().length, 1))
  f.switchContext({ storeId: sibling }); await screen.findByAltText('صورة قسم 12'); assert.ok(!screen.queryByRole('dialog')); assert.ok(!screen.queryByText('قسم 10'))
  await act(async () => gate.resolve(Response.json({ Id: id(80) }))); assert.equal(f.writes().length, 0); scoped(f.reads().at(-1), sibling)
})

test('a late list from the previous branch cannot appear, be signed or be edited in the new branch', async () => {
  const gate = deferred(), f = mount({ role: 'owner', intercept: c => c.pathname === table && c.params.get('store_id') === `eq.${branch}` && gate.promise })
  await waitFor(() => assert.equal(f.reads().length, 1)); f.switchContext({ storeId: sibling }); await screen.findByAltText('صورة قسم 12')
  await act(async () => gate.resolve(Response.json([row(10)])))
  assert.ok(!screen.queryByText('قسم 10')); assert.deepEqual(f.signs().flatMap(c => c.body.paths), [`${tenant}/${sibling}/12.png`])
})
