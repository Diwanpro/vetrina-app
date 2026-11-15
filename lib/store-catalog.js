// Store-type aware catalogue taxonomy (P5).
//
// The merchant picks «نوع المتجر» once; every product-creation dropdown then
// cascades from (store type, product type). Keeping the tree here — not inside
// JSX — lets the dashboard, the signup validation, the seed data and the tests
// agree on the same Arabic labels.

export const STORE_TYPES = Object.freeze({ MENS: 'mens', WOMENS: 'womens' })

export const STORE_TYPE_OPTIONS = Object.freeze([
  { value: STORE_TYPES.MENS, label: 'ملابس رجالية' },
  { value: STORE_TYPES.WOMENS, label: 'ملابس نسائية' },
])

export const STORE_TYPE_LABELS = Object.freeze({
  [STORE_TYPES.MENS]: 'ملابس رجالية',
  [STORE_TYPES.WOMENS]: 'ملابس نسائية',
})

export const PRODUCT_TYPES = Object.freeze(['ملابس', 'أحذية', 'إكسسوارات'])

export const STORE_CATEGORY_TREE = Object.freeze({
  [STORE_TYPES.MENS]: Object.freeze({
    'ملابس': Object.freeze([
      'قمصان رجالية', 'تيشيرتات رجالية', 'بناطيل رجالية', 'جاكيتات رجالية',
      'بولو رجالي', 'أطقم رسمية', 'سراويل رياضية',
    ]),
    'أحذية': Object.freeze([
      'أحذية كلاسيك', 'سنيكرز رجالي', 'صنادل رجالية', 'أحذية منزلية', 'أحذية عمل',
    ]),
    'إكسسوارات': Object.freeze([
      'أحزمة', 'محافظ', 'نظارات', 'قبعات', 'ساعات', 'جوارب',
    ]),
  }),
  [STORE_TYPES.WOMENS]: Object.freeze({
    'ملابس': Object.freeze([
      'فساتين', 'قفاطين', 'بلوزات', 'فساتين سهرة', 'تنانير', 'جاكيتات نسائية',
    ]),
    'أحذية': Object.freeze([
      'كعب عالي', 'صنادل', 'أحذية رياضية نسائية', 'أحذية مسطحة',
    ]),
    'إكسسوارات': Object.freeze([
      'حقائب', 'مجوهرات', 'أوشحة', 'نظارات نسائية', 'أحزمة نسائية',
    ]),
  }),
})

export function isStoreType(value) {
  return value === STORE_TYPES.MENS || value === STORE_TYPES.WOMENS
}

/** Legacy rows and offline caches without a type stay on the men's catalogue. */
export function normalizeStoreType(value) {
  return isStoreType(value) ? value : STORE_TYPES.MENS
}

export function isProductType(value) {
  return PRODUCT_TYPES.includes(value)
}

/** Cascading list for the second product dropdown. */
export function categoriesFor(storeType, productType) {
  const normalized = normalizeStoreType(storeType)
  if (!isProductType(productType)) return []
  return [...(STORE_CATEGORY_TREE[normalized]?.[productType] || [])]
}

/** Every category a store type can offer, used by the seed and mock loader. */
export function allCategoriesFor(storeType) {
  return PRODUCT_TYPES.flatMap(type => categoriesFor(storeType, type))
}

export function categoryAllowed(storeType, productType, category) {
  return categoriesFor(storeType, productType).includes(category)
}

export function storeTypeLabel(value) {
  return STORE_TYPE_LABELS[normalizeStoreType(value)] || STORE_TYPE_LABELS[STORE_TYPES.MENS]
}
