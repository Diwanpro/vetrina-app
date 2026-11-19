// Dashboard only. The authenticated client uses the existing row and object RLS.
import { supabase } from '@/lib/supabase'

const BUCKET = 'storefront-assets'
const PAGE_SIZE = 20
export const PREVIEW_SECONDS = 300
const extensions = new Map([['image/jpeg', 'jpg'], ['image/png', 'png'], ['image/webp', 'webp']])
export const STOREFRONT_IMAGE_TYPES = [...extensions.keys()].join(',')

export function imageExtension(file) {
  const ext = extensions.get(file?.type)
  if (!ext) throw new Error('اختر صورة بصيغة JPEG أو PNG أو WebP.')
  if (!file.size || file.size > 8 * 1024 * 1024) throw new Error('يجب ألا تكون الصورة فارغة أو أكبر من 8 ميبيبايت.')
  return ext
}

function isBranchKey(path, tenantId, storeId) {
  if (typeof path !== 'string') return false
  const parts = path.split('/')
  return parts.length === 3 && parts[0] === tenantId && parts[1] === storeId && /^[A-Za-z0-9_-]{1,128}\.(jpe?g|png|webp)$/.test(parts[2])
}

function fields(draft, label) {
  const title = draft.title.trim(), link = draft.link_url.trim(), order = String(draft.sort_order)
  if (!title) throw new Error(`أدخل عنوان ${label}.`)
  if (link) {
    const internal = link.startsWith('/') && !link.startsWith('//')
    let external = false
    if (/^https?:\/\/[^/?#]/i.test(link)) {
      try { external = Boolean(new URL(link).hostname) } catch { /* invalid host */ }
    }
    if ((!internal && !external) || /[\s\\\u0000-\u001f\u007f-\u009f]/.test(link)) {
      throw new Error('أدخل رابط HTTP أو HTTPS صالحاً، أو مساراً داخلياً يبدأ بشرطة مائلة واحدة (/).')
    }
  }
  if (!/^\d+$/.test(order) || Number(order) > 2147483647) throw new Error('أدخل ترتيباً صحيحاً بين 0 و2147483647.')
  if (!['draft', 'published'].includes(draft.status)) throw new Error(`اختر حالة ${label}.`)
  return { title, link_url: link || null, sort_order: Number(order), status: draft.status }
}

async function loadPage(tableName, tenantId, storeId, page) {
  const start = page * PAGE_SIZE
  const { data, error } = await supabase.from(tableName).select('id,title,image_url,link_url,sort_order,status')
    .eq('tenant_id', tenantId).eq('store_id', storeId).order('sort_order').order('id').range(start, start + PAGE_SIZE)
  if (error) throw error
  return { rows: data.slice(0, PAGE_SIZE), hasNext: data.length > PAGE_SIZE }
}

export async function signContentPreviews(rows, tenantId, storeId) {
  const keys = new Set(rows.map(row => row.image_url).filter(path => isBranchKey(path, tenantId, storeId)))
  if (!keys.size) return {}
  const { data, error } = await supabase.storage.from(BUCKET).createSignedUrls([...keys], PREVIEW_SECONDS)
  if (error) throw error
  return Object.fromEntries(data.filter(item => keys.has(item.path) && !item.error && item.signedUrl).map(item => [item.path, item.signedUrl]))
}

function unconfirmedSave() {
  return Object.assign(new Error('تعذر تأكيد الحفظ. أغلق المحرر وراجع القائمة قبل إعادة المحاولة.'), { unconfirmed: true })
}

async function saveItem(tableName, noun, { tenantId, storeId, original, draft, file, isActive }) {
  const label = `ال${noun}`
  const patch = fields(draft, label)
  let uploaded = null
  if (file) {
    const ext = imageExtension(file)
    const key = `${tenantId}/${storeId}/${crypto.randomUUID()}.${ext}`
    const { error } = await supabase.storage.from(BUCKET).upload(key, file, { contentType: file.type, upsert: false, cacheControl: '60' })
    if (error) throw new Error('تعذر رفع الصورة. تحقق من اتصالك وصلاحية الفرع، ثم أعد المحاولة.')
    uploaded = key
    patch.image_url = key
  } else if (!isBranchKey(original?.image_url, tenantId, storeId)) {
    throw new Error(`اختر صورة لل${noun}.`)
  }
  // Never delete a previous key (other records may reference it), or an upload
  // after an ambiguous write. Only the newly uploaded, known-unused key is safe.
  async function discardUpload() {
    if (uploaded) { try { await supabase.storage.from(BUCKET).remove([uploaded]) } catch { /* best effort */ } }
  }
  if (!isActive()) { await discardUpload(); return }
  let result
  try {
    const table = supabase.from(tableName)
    const write = original ? table.update(patch).eq('tenant_id', tenantId).eq('store_id', storeId).eq('id', original.id)
      : table.insert({ tenant_id: tenantId, store_id: storeId, ...patch })
    result = await write.select('id').maybeSingle()
  } catch { throw unconfirmedSave() }
  if (result.error) {
    // A proxy/transport error can arrive after a commit, even with a 4xx status.
    // Only a definitive Postgres rejection (data, constraint, access) is safe.
    if (!/^(22|23|42)[0-9A-Z]{3}$/.test(result.error.code)) throw unconfirmedSave()
    await discardUpload()
    throw new Error(`تعذر حفظ ${label}. تحقق من البيانات وصلاحية التعديل في هذا الفرع.`)
  }
  if (!result.data?.id) {
    if (!original) throw unconfirmedSave()
    await discardUpload()
    throw new Error(`لم يعد ${label} متاحاً للتعديل في هذا الفرع.`)
  }
}

// Bind the table in code, not to a URL parameter or a field in a merchant's form.
function contentCollection(tableName, noun, plural) {
  return {
    noun, plural, label: `ال${noun}`,
    loadPage: (tenantId, storeId, page) => loadPage(tableName, tenantId, storeId, page),
    save: entry => saveItem(tableName, noun, entry),
  }
}
export const bannerContent = contentCollection('storefront_banners', 'بانر', 'بانرات')
export const sectionContent = contentCollection('storefront_sections', 'قسم', 'أقسام')
