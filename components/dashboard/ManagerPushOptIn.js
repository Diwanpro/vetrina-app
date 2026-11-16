'use client'
import { useEffect, useState } from 'react'
import { supabase } from '@/lib/supabase'
import { urlBase64ToUint8Array } from '@/lib/pwa/client'

const bounded = promise => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('انتهت مهلة تشغيل Service Worker؛ حدّث الصفحة ثم أعد المحاولة.')), 12000)
  Promise.resolve(promise).then(value => { clearTimeout(timer); resolve(value) }, err => { clearTimeout(timer); reject(err) })
})
export default function ManagerPushOptIn({ ctx }) {
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')
  const [diagnostics, setDiagnostics] = useState(null)
  const allowed = ctx?.storeId && ['owner', 'manager'].includes(ctx.role)
  async function api(path, body, method = 'POST') {
    const { data } = await supabase.auth.getSession()
    const response = await fetch(path, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${data?.session?.access_token || ''}` }, body: JSON.stringify({ storeId: ctx.storeId, ...body }), signal: AbortSignal.timeout(20000) })
    const result = await response.json()
    if (!response.ok) throw new Error(result.error || 'تعذر تنفيذ الطلب')
    return result
  }
  async function inspect() {
    const supported = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window
    const result = { supported, secure: window.isSecureContext, permission: typeof Notification === 'undefined' ? 'غير مدعوم' : Notification.permission }
    try {
      const worker = await fetch('/service-worker.js', { cache: 'no-store' })
      result.workerFile = worker.ok && /javascript/.test(worker.headers.get('content-type') || '') ? `سليم (${worker.status})` : `خطأ (${worker.status})`
      const reg = supported ? await navigator.serviceWorker.getRegistration('/') : null
      result.registeredWorker = Boolean(reg)
      result.active = reg?.active?.state === 'activated'
      const subscription = reg ? await reg.pushManager.getSubscription() : null
      result.browserSubscription = Boolean(subscription)
      const config = await (await fetch('/api/push/public-key', { cache: 'no-store' })).json()
      const usedKey = subscription?.options?.applicationServerKey
      const expected = config.publicKey ? urlBase64ToUint8Array(config.publicKey) : null
      const actual = usedKey ? new Uint8Array(usedKey) : null
      result.vapidMatch = Boolean(actual && expected && actual.length === expected.length && actual.every((byte, index) => byte === expected[index]))
      const server = await api('/api/push/staff/diagnostics', { subscription: subscription?.toJSON() || null })
      Object.assign(result, server)
    } catch (err) { result.error = err.message }
    setDiagnostics(result)
  }
  useEffect(() => { setDiagnostics(null); if (allowed) inspect() }, [ctx?.storeId, ctx?.staffId, allowed]) // eslint-disable-line react-hooks/exhaustive-deps
  if (!allowed) return null
  async function act(kind) {
    if (kind === 'reset' && !confirm('سيتم إلغاء اشتراك Push القديم لهذا الجهاز وإنشاء آخر جديد. ستحتاج إعادة تفعيل الفروع الأخرى وإشعارات الزبائن إن كانت تستخدم نفس الاشتراك. متابعة؟')) return
    setBusy(true); setNotice('')
    try {
      if (kind === 'diagnose') { await inspect(); return }
      if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) throw new Error('المتصفح لا يدعم Push. على iPhone ثبّت التطبيق على الشاشة الرئيسية وافتحه منها.')
      if (['enable', 'reset'].includes(kind) && await Notification.requestPermission() !== 'granted') throw new Error('اسمح بالإشعارات من إعدادات المتصفح ثم أعد المحاولة.')
      await bounded(navigator.serviceWorker.register('/service-worker.js', { scope: '/', updateViaCache: 'none' }))
      const registration = await bounded(navigator.serviceWorker.ready)
      await bounded(registration.update())
      let subscription = await registration.pushManager.getSubscription()
      if (kind === 'test') {
        if (!subscription) throw new Error('لا يوجد اشتراك في هذا المتصفح؛ أعد تسجيل الإشعارات.')
        const result = await api('/api/push/staff/test', { subscription: subscription.toJSON() })
        setNotice(result.sent ? 'قبل مزود Push الطلب لهذا الجهاز فقط؛ لم يتم تأكيد ظهور الإشعار على الهاتف. تحقق من إعدادات النظام وعدم الإزعاج.' : (result.failures?.map(item => `${item.reason} (${item.status || 'اتصال'})`).join(' · ') || 'لم يقبل المزود الإرسال. أعد التسجيل.'))
        return
      }
      if (kind === 'disable') {
        if (subscription) await api('/api/push/staff/subscribe', { endpoint: subscription.endpoint }, 'DELETE')
        setNotice('تم إيقاف تنبيهات المدير لهذا الفرع على هذا الجهاز.')
        return
      }
      const key = await (await fetch('/api/push/public-key', { cache: 'no-store' })).json()
      if (!key.publicKey) throw new Error('إعدادات Push غير مكتملة على الخادم')
      if (kind === 'reset' && subscription) {
        await api('/api/push/staff/subscribe', { endpoint: subscription.endpoint, reset: true }, 'DELETE')
        if (!await subscription.unsubscribe()) throw new Error('تعذر إلغاء الاشتراك القديم. أعد المحاولة.')
        subscription = null
      }
      if (!subscription) subscription = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(key.publicKey) })
      await api('/api/push/staff/subscribe', { subscription: subscription.toJSON() })
      setNotice('حُفظ اشتراك هذا الجهاز. راجع التشخيص ثم أرسل إشعاراً تجريبياً. تسجيل الاشتراك لا يؤكد الاستلام.')
    } catch (err) { setNotice(err.message) }
    finally { await inspect(); setBusy(false) }
  }
  const yes = value => value === undefined ? 'غير معروف' : value ? 'نعم' : 'لا'
  return <section className="mb-4 rounded-xl border border-gold/20 bg-[#191919] p-3">
    <h2 className="mb-2 text-sm text-gold">تشخيص Push · هاتف المدير · الفرع المحدد</h2>
    <p className="mb-2 text-xs text-neutral-400">على iPhone ثبّت التطبيق على الشاشة الرئيسية وافتحه منها. اسمح بإشعارات النظام وأوقف وضع عدم الإزعاج عند الاختبار.</p>
    {diagnostics && <dl className="mb-3 grid gap-1 text-xs text-neutral-300" aria-live="polite">
      <div>المتصفح يدعم الإشعارات: {yes(diagnostics.supported)}</div>
      <div>اتصال آمن HTTPS: {yes(diagnostics.secure)} · الإذن: {diagnostics.permission}</div>
      <div>ملف service-worker.js: {diagnostics.workerFile || 'غير معروف'}</div>
      <div>Service Worker مسجل: {yes(diagnostics.registeredWorker)} · نشط Active: {yes(diagnostics.active)}</div>
      <div>اشتراك في المتصفح: {yes(diagnostics.browserSubscription)}</div>
      <div>اشتراك هذا الجهاز محفوظ في قاعدة البيانات للفرع والحساب: {yes(diagnostics.registered)}</div>
      <div>مفتاح VAPID في المتصفح يطابق الخادم: {yes(diagnostics.vapidMatch)}</div>
      <div>مفاتيح الاشتراك متطابقة: {yes(diagnostics.keysMatch)} · إعداد Push بالخادم: {yes(diagnostics.configured)}</div>
      {diagnostics.error && <p role="alert" className="text-red-300">{diagnostics.error}</p>}
    </dl>}
    <div className="flex flex-wrap gap-2">{[['diagnose','تحديث التشخيص'],['enable','تفعيل Push للمدير'],['reset','إعادة تسجيل الإشعارات'],['test','إرسال إشعار تجريبي لهذا الجهاز'],['disable','إيقاف لهذا الفرع']].map(([kind,label]) => <button key={kind} disabled={busy} onClick={() => act(kind)} type="button" className="rounded-lg border border-gold/30 px-3 py-2 text-xs text-gold disabled:opacity-50">{label}</button>)}</div>
    {notice && <p role="status" className="mt-2 text-xs text-neutral-200">{notice}</p>}
  </section>
}
