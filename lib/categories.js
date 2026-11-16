// Backwards-compatible entry point for the product form.
//
// P5 moved the taxonomy into lib/store-catalog.js so it can cascade by store
// type. This module keeps the old names used elsewhere in the dashboard and
// makes MAIN_CATEGORIES mean «نوع المنتج» rather than a single static tree.

import { PRODUCT_TYPES, categoriesFor, normalizeStoreType } from './store-catalog.js'

export {
  STORE_TYPES, STORE_TYPE_OPTIONS, STORE_TYPE_LABELS, PRODUCT_TYPES,
  STORE_CATEGORY_TREE, normalizeStoreType, isStoreType, isProductType,
  categoriesFor, allCategoriesFor, categoryAllowed, storeTypeLabel,
} from './store-catalog.js'

/** Legacy default tree: men's categories, kept for any older caller. */
export const CATEGORY_TREE = Object.freeze(
  Object.fromEntries(PRODUCT_TYPES.map(type => [type, categoriesFor('mens', type)])),
)

export const MAIN_CATEGORIES = PRODUCT_TYPES

/**
 * Legacy signature: subcategoriesFor(category).
 * New callers pass the store type as the second argument.
 */
export function subcategoriesFor(category, storeType = 'mens') {
  return categoriesFor(normalizeStoreType(storeType), category)
}
