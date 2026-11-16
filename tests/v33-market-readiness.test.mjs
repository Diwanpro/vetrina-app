import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { brandsFor, cleanBrand } from '../lib/brand-catalog.js'
import { validateStoreLogo, logoUploadError } from '../lib/store-logo.js'
import { productMatchesSpecialty } from '../lib/store-catalog.js'
const read = p => fs.readFile(new URL(`../${p}`, import.meta.url), 'utf8')
test('logo validation gives actionable unsupported/oversized/empty errors', () => {
 assert.equal(validateStoreLogo({type:'image/png',size:200}),null)
 assert.ok(validateStoreLogo({type:'image/heic',size:200}).includes('HEIC'))
 assert.ok(validateStoreLogo({type:'image/png',size:2097153}).includes('2'))
 assert.ok(validateStoreLogo({type:'image/jpeg',size:0}))
 assert.ok(logoUploadError({message:'new row violates row-level security policy'}).includes('إذن'))
})
test('brands cascade by type/category, accept local typed brands and sanitize', () => {
 assert.ok(brandsFor('أحذية','حذاء رياضي').some(o=>o.value==='Nike'))
 assert.ok(brandsFor('ملابس','فساتين سهرة').some(o=>o.value==='Mango'))
 assert.ok(brandsFor('إكسسوارات','ساعات').some(o=>o.value==='Casio'))
 assert.ok(brandsFor('ملابس','فساتين',['ماركتي']).some(o=>o.value==='ماركتي'))
 assert.equal(cleanBrand(' a\u0000 '),'a')
 assert.equal(cleanBrand('x'.repeat(200)).length,80)
})
test('opposite specialty never leaks known categories; mixed and custom remain intact', () => {
 assert.equal(productMatchesSpecialty({subcategory:'قمصان رجالية'},'womens'),false)
 assert.equal(productMatchesSpecialty({subcategory:'فساتين'},'mens'),false)
 assert.equal(productMatchesSpecialty({subcategory:'فساتين'},'womens'),true)
 assert.equal(productMatchesSpecialty({subcategory:'فساتين'},'mixed'),true)
 assert.equal(productMatchesSpecialty({subcategory:'تصنيف خاص'},'womens'),true)
})
test('grouped routes and nested routes resolve to their own gold navigation item', async () => {
 const source=await read('components/dashboard/navItems.js')
 const logic=source.slice(source.indexOf('export const ROUTE_GROUPS')).replaceAll('export ','')
 const activeGroup=new Function(`${logic};return activeGroup`)()
 for (const path of ['stock','operations','management','customers-credit','pos','settings','orders']) assert.equal(activeGroup(`/dashboard/${path}`),`/dashboard/${path}`)
 assert.equal(activeGroup('/dashboard/products/barcodes'),'/dashboard/stock')
 for (const file of ['Sidebar','BottomNav']) {
  const source=await read(`components/dashboard/${file}.js`)
  assert.match(source,/usePathname/); assert.match(source,/activeGroup\(pathname \|\| active\)/)
 }
})
test('product form begins type then category then searchable CustomSelect brand and persists it', async () => {
 const source=await read('app/dashboard/_screens/products.js')
 const form=source.slice(source.indexOf('<div className="space-y-3">'))
 assert.ok(form.indexOf('نوع المنتج')<form.indexOf('التصنيف (حسب نوع المتجر)'))
 assert.ok(form.indexOf('التصنيف (حسب نوع المتجر)')<form.indexOf('الماركة / اسم المنتج'))
 assert.match(form,/<CustomSelect searchable allowCreate/)
 assert.match(source,/brand: cleanBrand\(form.brand\)/)
 assert.doesNotMatch(source,/<select\b/)
})
test('logo RLS namespaces and specialty updates are authenticated, role-checked, no orders writes', async () => {
 const sql=await read('supabase/migrations/202611130022_v33_logo_brands_profiles.sql')
 for (const pattern of [/2097152/,/engine_logo_access/,/parts\[1\]=u.tenant_id::text/,/s.id=u.store_id/,/PERFORM public.engine_staff/,/ADD COLUMN IF NOT EXISTS brand/,/ADD TABLE public.stores/]) assert.match(sql,pattern)
 assert.doesNotMatch(sql,/(?:ALTER TABLE|INSERT INTO|UPDATE|DELETE FROM) public.orders\b/i)
})
test('branch changes update open dashboard and public store without manual reload', async () => {
 const session=await read('components/dashboard/SessionProvider.js'),store=await read('components/store/Storefront.js'),settings=await read('app/dashboard/_screens/settings.js')
 assert.match(session,/postgres_changes/); assert.match(session,/ctx.storeType/)
 assert.match(store,/refreshProfile/); assert.match(store,/setInterval\(refreshProfile, 5000\)/)
 assert.match(settings,/engine_set_branch_specialty/)
 assert.match(settings,/vetrina:auth/)
})
