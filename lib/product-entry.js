import { sizeLabel } from './product-attributes.js'
// Smart Product Entry (v3.2).
//
// The merchant is required to provide ONLY: an image, a colour, available sizes
// and a quantity. Everything else — a sellable name, a commercial Arabic
// description, a price placeholder and a barcode — is generated here or by the
// server. Keeping the copy pure means the exact Arabic wording is testable
// without a browser, a database or a camera.

import { normalizeStoreType } from './store-catalog.js'

export const SMART_REQUIRED_FIELDS = Object.freeze(['image', 'color', 'sizes', 'quantity'])

export const FABRIC_OPTIONS = Object.freeze([
  { value: '', label: 'نوع القماش · اختياري' },
  { value: 'الحرير', label: 'الحرير' },
  { value: 'القطن', label: 'القطن' },
  { value: 'الكتان', label: 'الكتان' },
  { value: 'المخمل', label: 'المخمل' },
  { value: 'الشيفون', label: 'الشيفون' },
  { value: 'الدانتيل', label: 'الدانتيل' },
  { value: 'الجلد الطبيعي', label: 'الجلد الطبيعي' },
  { value: 'البوليستر', label: 'البوليستر' },
  { value: 'الصوف', label: 'الصوف' },
])

export const STYLE_OPTIONS = Object.freeze([
  { value: '', label: 'الستايل · اختياري' },
  { value: 'عصري', label: 'عصري' },
  { value: 'كلاسيك', label: 'كلاسيك' },
  { value: 'كاجوال', label: 'كاجوال' },
  { value: 'رسمي', label: 'رسمي' },
  { value: 'مطرّز', label: 'مطرّز' },
  { value: 'بسيط', label: 'بسيط' },
  { value: 'فاخر', label: 'فاخر' },
])

export const OCCASION_OPTIONS = Object.freeze([
  { value: '', label: 'المناسبة · اختيارية' },
  { value: 'السهرة', label: 'السهرة' },
  { value: 'العمل', label: 'العمل' },
  { value: 'الخروجات اليومية', label: 'الخروجات اليومية' },
  { value: 'الأعراس', label: 'الأعراس' },
  { value: 'الصيف', label: 'الصيف' },
  { value: 'الشتاء', label: 'الشتاء' },
])

export const SEASON_OPTIONS = Object.freeze([
  { value: '', label: 'الموسم · اختياري' },
  { value: 'ربيع / صيف', label: 'ربيع / صيف' },
  { value: 'خريف / شتاء', label: 'خريف / شتاء' },
  { value: 'كل المواسم', label: 'كل المواسم' },
])

// A plural taxonomy label becomes a natural singular product name.
const ITEM_LABELS = Object.freeze({
  'فساتين سهرة': 'فستان سهرة',
  'فساتين': 'فستان',
  'قفاطين': 'قفطان',
  'بلوزات': 'بلوزة',
  'تنانير': 'تنورة',
  'جاكيتات نسائية': 'جاكيت نسائي',
  'كعب عالي': 'حذاء بكعب عالٍ',
  'صنادل': 'صندل',
  'أحذية رياضية نسائية': 'حذاء رياضي نسائي',
  'أحذية مسطحة': 'حذاء مسطح',
  'حقائب': 'حقيبة',
  'مجوهرات': 'قطعة مجوهرات',
  'أوشحة': 'وشاح',
  'نظارات نسائية': 'نظارة نسائية',
  'أحزمة نسائية': 'حزام نسائي',
  'قمصان رجالية': 'قميص رجالي',
  'تيشيرتات رجالية': 'تيشيرت رجالي',
  'بناطيل رجالية': 'بنطال رجالي',
  'جاكيتات رجالية': 'جاكيت رجالي',
  'أطقم رسمية': 'طقم رسمي',
  'سراويل رياضية': 'سروال رياضي',
  'أحذية كلاسيك': 'حذاء كلاسيك',
  'سنيكرز رجالي': 'سنيكرز رجالي',
  'صنادل رجالية': 'صندل رجالي',
  'أحذية منزلية': 'حذاء منزلي',
  'أحذية عمل': 'حذاء عمل',
  'أحزمة': 'حزام',
  'محافظ': 'محفظة',
  'نظارات': 'نظارة',
  'قبعات': 'قبعة',
  'ساعات': 'ساعة',
  'جوارب': 'زوج جوارب',
})

const ITEM_ADJECTIVES = Object.freeze({
  'فستان سهرة': 'أنيق',
  'فستان': 'أنيق',
  'قفطان': 'فاخر',
  'قميص رجالي': 'مرتب',
  'حذاء كلاسيك': 'أنيق',
  'حذاء بكعب عالٍ': 'أنيق',
  'حقيبة': 'عملية',
  'ساعة': 'أنيقة',
})

function clean(value, max = 120) {
  return String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max)
}

function itemLabel(specs) {
  const raw = clean(specs.subcategory || specs.category || specs.name || 'قطعة', 80)
  return ITEM_LABELS[raw] || raw || 'قطعة'
}

function genderLabel(storeType) {
  const type = normalizeStoreType(storeType)
  if (type === 'womens') return 'نسائي'
  if (type === 'mens') return 'رجالي'
  return ''
}

export function smartSpecsFromForm(form = {}, cells = [], ctx = {}) {
  const list = Array.isArray(cells) ? cells : []
  const colors = [...new Set(list.map(cell => clean(cell.color, 60)).filter(Boolean))]
  const sizes = [...new Set(list.map(cell => clean(cell.size, 40)).filter(Boolean))]
  return {
    name: clean(form.name, 120),
    category: clean(form.category, 80),
    subcategory: clean(form.subcategory, 80),
    color: colors.join('، '),
    fabric: clean(form.fabric, 60),
    style: clean(form.style, 60),
    occasion: clean(form.occasion, 60),
    season: clean(form.season, 60),
    sizes,
    storeType: ctx.storeType || 'mens',
  }
}

/** A short, sellable name for merchants who leave the name field empty. */
export function generateProductName(specs = {}) {
  const parts = [itemLabel(specs), genderLabel(specs.storeType)]
  if (clean(specs.fabric, 60)) parts.push(`من ${clean(specs.fabric, 60)}`)
  if (clean(specs.style, 60)) parts.push(`بستايل ${clean(specs.style, 60)}`)
  if (clean(specs.color, 60)) parts.push(`باللون ${clean(specs.color, 60)}`)
  return parts.filter(Boolean).join(' ').trim() || 'منتج جديد'
}

/**
 * generateDescription() — the requested function. It turns the product's
 * colour, fabric, category/style and available sizes into an attractive Arabic
 * commercial description. Example: «فستان سهرة أنيق من الحرير باللون الأحمر…».
 */
export function generateDescription(specs = {}) {
  const item = itemLabel(specs)
  const gender = genderLabel(specs.storeType)
  const subject = [item, gender].filter(Boolean).join(' ')
  const material = clean(specs.fabric, 60)
  const colour = clean(specs.color, 60)
  const style = clean(specs.style, 60)
  const occasion = clean(specs.occasion, 60)
  const season = clean(specs.season, 60)
  const sizes = Array.isArray(specs.sizes) ? specs.sizes.map(size => clean(size, 40)).filter(Boolean) : []
  const adjective = style || ITEM_ADJECTIVES[item] || 'أنيق'

  const lead = `${subject} ${adjective}${material ? ` من ${material}` : ''}${colour ? ` باللون ${colour}` : ''}، بقصة مريحة وتفاصيل تمنحك حضوراً مميزاً.`
  const extras = []
  if (occasion) extras.push(`مثالي لـ${occasion}`)
  if (season) extras.push(`يناسب ${season}`)
  if (sizes.length) extras.push(`متوفر بمقاسات ${[...new Set(sizes)].map(sizeLabel).join('، ')}`)
  extras.push('اختيار يجمع بين الجودة والأناقة، جاهز ليضيف لمسة خاصة إلى إطلالتك.')

  return [lead, ...extras].join(' ').replace(/\s+/g, ' ').trim().slice(0, 4000)
}

/**
 * Only the four merchant-facing fields are mandatory. Name, price, category,
 * description, fabric, style and barcode are optional or generated.
 */
export function validateSmartEntry({ imageFile, imagePreview, cells = [] } = {}) {
  if (!imageFile && !imagePreview) return 'صورة المنتج إلزامية: التقط صورة أو ارفع صورة.'
  if (!Array.isArray(cells) || !cells.length) {
    return 'اللون والمقاسات المتاحة والكمية إلزامية: أدخل كمية واحدة على الأقل.'
  }
  const colors = new Set()
  const sizes = new Set()
  for (const cell of cells) {
    const color = clean(cell.color, 60)
    const size = clean(cell.size, 40)
    const qty = Number(cell.qty)
    if (!color) return 'اللون إلزامي.'
    if (!size) return 'المقاسات المتاحة إلزامية.'
    if (!Number.isSafeInteger(qty) || qty <= 0) return 'الكمية يجب أن تكون عدداً صحيحاً موجباً.'
    colors.add(color)
    sizes.add(size)
  }
  if (!colors.size || !sizes.size) return 'أدخل لوناً ومقاساً وكمية صحيحة.'
  return null
}
