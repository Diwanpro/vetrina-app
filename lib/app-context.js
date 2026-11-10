import { supabase } from '@/lib/supabase'

export async function getAppContext() {
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) return { user: null, tenantId: null, storeId: null }

  // Auth IDs and staff IDs are different in the database.
  let { data: row, error: staffError } = await supabase
    .from('users')
    .select('id, tenant_id, store_id, role, is_active')
    .eq('auth_id', user.id)
    .maybeSingle()
  if (staffError) throw staffError
  if (!row) {
    const legacy = await supabase.from('users').select('id, tenant_id, store_id, role, is_active').eq('id', user.id).maybeSingle()
    if (legacy.error) throw legacy.error
    row = legacy.data
  }
  if (!row || row.is_active === false) throw new Error('لا يوجد ملف موظف نشط لهذا المستخدم')

  let storeId = row?.store_id || null
  if (!storeId && row?.tenant_id) {
    const { data: store, error: storeError } = await supabase
      .from('stores')
      .select('id')
      .eq('tenant_id', row.tenant_id)
      .order('created_at').order('id')
      .limit(1)
      .maybeSingle()
    if (storeError) throw storeError
    storeId = store?.id || null
  }

  return { user, staffId: row.id, role: row.role, tenantId: row.tenant_id, storeId }
}

export function formatDzd(value) {
  const n = Number(value || 0)
  return `${n.toLocaleString('fr-DZ')} دج`
}
