import { supabase } from '@/lib/supabase'

export async function getAppContext() {
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) return { user: null, tenantId: null, storeId: null }

  const { data: row } = await supabase
    .from('users')
    .select('id, tenant_id, store_id, role')
    .eq('id', user.id)
    .maybeSingle()

  let storeId = row?.store_id || null
  if (!storeId && row?.tenant_id) {
    const { data: store } = await supabase
      .from('stores')
      .select('id')
      .eq('tenant_id', row.tenant_id)
      .limit(1)
      .maybeSingle()
    storeId = store?.id || null
  }

  return { user, tenantId: row?.tenant_id || null, storeId }
}

export function formatDzd(value) {
  const n = Number(value || 0)
  return `${n.toLocaleString('fr-DZ')} دج`
}
