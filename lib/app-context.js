import { supabase } from '@/lib/supabase'
import { localGet, localSet } from '@/lib/local-db'
import { selectScope, subscriptionLocked, isNetworkError } from '@/lib/access'

let flight
export function getAppContext() {
  if (!flight) flight = loadContext().finally(() => { flight = null })
  return flight
}
async function loadContext() {
  let user, profile
  let offline = typeof navigator !== 'undefined' && !navigator.onLine
  async function cachedIdentity() {
    const id = localStorage.getItem('vetrina.auth')
    if (!id) throw new Error('تسجيل الدخول لأول مرة يتطلب الاتصال بالإنترنت')
    const cached = await localGet(`profile:${id}`)
    if (!cached || cached.user.id !== id) throw new Error('لا توجد جلسة محلية موثوقة. سجّل الدخول أثناء الاتصال.')
    user = cached.user; profile = cached.profile
  }
  if (offline) { await cachedIdentity() } else {
    try {
      const { data, error } = await supabase.auth.getUser()
      if (error) throw error
      if (!data.user) throw new Error('انتهت الجلسة. سجّل الدخول مجدداً.')
      user = { id: data.user.id, email: data.user.email }
      const result = await supabase.rpc('engine_session')
      if (result.error) throw result.error
      profile = result.data
      if (!profile?.staffId) throw new Error('لا يوجد ملف موظف نشط لهذا المستخدم')
      if (typeof window !== 'undefined') {
        const session = await supabase.auth.getSession()
        if (session.data.session?.user.id !== user.id) throw new Error('تغير الحساب. أعد تسجيل الدخول.')
        localStorage.setItem('vetrina.auth', user.id)
        await localSet(`profile:${user.id}`, { user, profile }).catch(() => {})
      }
    } catch (err) {
      if (!isNetworkError(err) || typeof window === 'undefined') throw err
      await cachedIdentity(); offline = true
    }
  }
  const selected = typeof window === 'undefined' ? null : localStorage.getItem(`vetrina.branch:${user.id}:${profile.tenantId}`)
  const scope = selectScope(profile, profile.stores || [], selected)
  return { ...profile, ...scope, user, offline, locked: subscriptionLocked(profile.tenant) }
}
export function changeBranch(ctx, id) {
  if (ctx.role !== 'owner') throw new Error('تغيير الفرع متاح للمالك فقط')
  if (id !== 'all' && !ctx.stores.some(store => store.id === id)) throw new Error('فرع غير صالح')
  localStorage.setItem(`vetrina.branch:${ctx.user.id}:${ctx.tenantId}`, id)
  window.location.assign(id === 'all' ? '/dashboard' : window.location.pathname)
}
export function formatDzd(value) {
  return `${Number(value || 0).toLocaleString('fr-DZ')} دج`
}
