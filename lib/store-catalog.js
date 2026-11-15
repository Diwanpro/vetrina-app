// Branch-specialty aware catalogue taxonomy (v3.1).
//
// «تخصص الفرع» belongs to the BRANCH, never to the account: one merchant can
// run a men's branch, a women's branch and a mixed branch at the same time.
// Keeping the tree here — not inside JSX — lets the dashboard, the signup
// first-branch form, the seed data, the theme engine and the tests agree on
// the same Arabic labels.

export const STORE_TYPES = Object.freeze({
  MENS: 'mens',
  WOMENS: 'womens',
  MIXED: 'mixed',
})

export const STORE_TYPE_OPTIONS = Object.freeze([
  { value: STORE_TYPES.MENS, label: 'ملابس رجالية' },
  { value: STORE_TYPES.WOMENS, label: 'ملابس نسائية' },
  { value: STORE_TYPES.MIXED, label: 'متعدد' },
])

// Explicit branch-level naming for the v3.1 settings UI.
export const BRANCH_SPECIALTY_OPTIONS = STORE_TYPE_OPTIONS

export const STORE_TYPE_LABELS = Object.freeze({
  [STORE_TYPES.MENS]: 'ملابس رجالية',
  [STORE_TYPES.WOMENS]: 'ملابس نسائية',
  [STORE_TYPES.MIXED]: 'متعدد',
})

export const PRODUCT_TYPES = Object.freeze(['ملابس', 'أحذية', 'إكسسوارات'])

const MENS_TREE = Object.freeze({
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
})

const WOMENS_TREE = Object.freeze({
  'ملابس': Object.freeze([
    'فساتين', 'قفاطين', 'بلوزات', 'فساتين سهرة', 'تنانير', 'جاكيتات نسائية',
  ]),
  'أحذية': Object.freeze([
    'كعب عالي', 'صنادل', 'أحذية رياضية نسائية', 'أحذية مسطحة',
  ]),
  'إكسسوارات': Object.freeze([
    'حقائب', 'مجوهرات', 'أوشحة', 'نظارات نسائية', 'أحزمة نسائية',
  ]),
})

/** A «متعدد» branch gets the union of both trees, without duplicate labels. */
const MIXED_TREE = Object.freeze(Object.fromEntries(PRODUCT_TYPES.map(type => [
  type,
  Object.freeze([...new Set([...MENS_TREE[type], ...WOMENS_TREE[type]])]),
])))

export const STORE_CATEGORY_TREE = Object.freeze({
  [STORE_TYPES.MENS]: MENS_TREE,
  [STORE_TYPES.WOMENS]: WOMENS_TREE,
  [STORE_TYPES.MIXED]: MIXED_TREE,
})

export function isStoreType(value) {
  return value === STORE_TYPES.MENS || value === STORE_TYPES.WOMENS || value === STORE_TYPES.MIXED
}

/** Legacy rows and offline caches without a type stay on the men's catalogue. */
export function normalizeStoreType(value) {
  return isStoreType(value) ? value : STORE_TYPES.MENS
}

export function isMixedStoreType(value) {
  return value === STORE_TYPES.MIXED
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

/** Every category a branch specialty can offer, used by the seed and mock loader. */
export function allCategoriesFor(storeType) {
  return PRODUCT_TYPES.flatMap(type => categoriesFor(storeType, type))
}

export function categoryAllowed(storeType, productType, category) {
  return categoriesFor(storeType, productType).includes(category)
}

export function storeTypeLabel(value) {
  return STORE_TYPE_LABELS[normalizeStoreType(value)] || STORE_TYPE_LABELS[STORE_TYPES.MENS]
}
