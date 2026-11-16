// SERVER-ONLY authorisation for the merchant push dispatcher (v3.1).
// Mirrors lib/shipping/index.js::authorize: verify the caller's Supabase JWT,
// re-check engine_session + engine_staff, and prove the target branch belongs
// to that tenant before any notification is sent.

import { createClient } from '@supabase/supabase-js'
import { isValidUuid } from './subscription.js'

export class PushAuthError extends Error {
  constructor(message, status = 401) {
    super(message)
    this.status = status
  }
}

function bearer(request) {
  const header = request.headers.get('authorization') || ''
  const match = header.match(/^Bearer\s+(.+)$/i)
  if (!match?.[1]) throw new PushAuthError('يرجى تسجيل الدخول مجدداً', 401)
  return match[1].trim()
}

export async function authorizeDispatch(request, storeId) {
  if (!isValidUuid(storeId)) throw new PushAuthError('معرّف الفرع غير صالح', 400)
  const token = bearer(request)
  const url = String(process.env.NEXT_PUBLIC_SUPABASE_URL || '').trim()
  const anonKey = String(process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '').trim()
  if (!url || !anonKey) throw new PushAuthError('إعدادات الخادم غير مكتملة', 500)

  const userClient = createClient(url, anonKey, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  })

  const { data: identity, error: authError } = await userClient.auth.getUser()
  if (authError || !identity?.user) throw new PushAuthError('انتهت الجلسة، سجّل الدخول مجدداً', 401)

  const { data: ctx, error: sessionError } = await userClient.rpc('engine_session')
  if (sessionError || !ctx?.staffId) throw new PushAuthError('تعذر التحقق من ملف الموظف', 401)
  if (!['owner', 'manager'].includes(ctx.role)) {
    throw new PushAuthError('إرسال الإشعارات متاح للمالك أو المدير فقط', 403)
  }
  if (!Array.isArray(ctx.stores) || !ctx.stores.some(store => store.id === storeId)) {
    throw new PushAuthError('غير مصرح لهذا الفرع', 403)
  }
  const { error: staffError } = await userClient.rpc('engine_staff', {
    p_store: storeId,
    p_tenant: ctx.tenantId,
  })
  if (staffError) throw new PushAuthError(staffError.message || 'غير مصرح لهذا الفرع', 403)
  return ctx
}
