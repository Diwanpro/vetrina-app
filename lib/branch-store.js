// Build links only from branches supplied by the authenticated session.
export function branchStoreHref(stores, storeId) {
  const store = (stores || []).find(row => row.id === storeId)
  const slug = typeof store?.slug === 'string' ? store.slug.trim() : ''
  return slug ? `/s/${encodeURIComponent(slug)}` : ''
}
