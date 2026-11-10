import { supabase } from '@/lib/supabase'
import { getAppContext } from '@/lib/app-context'

// Fail closed: callers must not apply a price change if its audit write fails.
export async function logAction(action, details) {
  const { user, staffId, storeId } = await getAppContext()
  if (!user || !storeId) throw new Error('تعذر تحديد المستخدم أو المتجر لسجل التدقيق')
  const { error } = await supabase.from('audit_log').insert({
    user_id: staffId,
    store_id: storeId,
    action,
    details,
    device_info: typeof navigator === 'undefined' ? 'server' : navigator.userAgent,
  })
  if (error) throw error
}
