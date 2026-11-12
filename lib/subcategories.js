// Custom subcategories persisted per tenant. Reading happens once per page
// load (a refresh is enough to pick up another device's additions); writing
// needs a connection, which product creation already requires.

export async function loadCustomSubcategories(supabase, tenantId) {
  const { data, error } = await supabase.rpc('engine_subcategories', { p_tenant: tenantId })
  if (error) throw error
  const byCategory = {}
  for (const row of data || []) {
    if (!row?.category || !row?.name) continue
    ;(byCategory[row.category] ||= []).push(row.name)
  }
  return byCategory
}

export async function saveCustomSubcategory(supabase, { tenantId, category, name }) {
  const cleanName = (name || '').trim()
  const cleanCategory = (category || '').trim()
  if (!cleanName || !cleanCategory) return null
  const { error } = await supabase.rpc('engine_add_subcategory', {
    p_tenant: tenantId,
    p_category: cleanCategory,
    p_name: cleanName,
  })
  if (error) throw error
  return { category: cleanCategory, name: cleanName }
}
