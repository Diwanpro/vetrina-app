'use client'
import { useState } from 'react'
import { supabase } from '@/lib/supabase'
import { urlBase64ToUint8Array } from '@/lib/pwa/client'

export default function ManagerPushOptIn({ ctx }) {
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')
  if (!ctx?.storeId || !['owner', 'manager'].includes(ctx.role)) return null
  async function api(path, body, method = 'POST') {
    const { data } = await supabase.auth.getSession()
    const response = await fetch(path, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${data?.session?.access_token || ''}` }, body: JSON.stringify({ storeId: ctx.storeId, ...body }) })
    const result = await response.json()
    if (!response.ok) throw new Error(result.error || 'تعذر تنفيذ الطلب')
    return result
  }
  async function act(kind) {
    setBusy(true); setNotice('')
    try {
      if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) throw new Error('المتصفح لا يدعم Push. على iPhone ثبّت التطبيق على الشاشة الرئيسية وافتحه منها.')
      if (kind === 'test') {
        const result = await api('/api/push/staff/test', {})
        setNotice(result.sent ? 'قبلت خدمة Push الإشعار التجريبي. تحقق من ظهوره على هاتفك؛ قبول الإرسال لا يثبت الاستلام.' : 'لا يوجد اشتراك صالح لهذا الحساب والفرع، أو تعذر الإرسال. فعّل الاشتراك أولاً.')
        return
      }
      if (kind === 'enable' && await Notification.requestPermission() !== 'granted') throw new Error('اسمح بالإشعارات من إعدادات المتصفح ثم أعد المحاولة.')
      await navigator.serviceWorker.register('/service-worker.js', { scope: '/' })
      const registration = await navigator.serviceWorker.ready
      let subscription = await registration.pushManager.getSubscription()
      if (kind === 'disable') {
        if (subscription) await api('/api/push/staff/subscribe', { endpoint: subscription.endpoint }, 'DELETE')
        // Keep browser subscription: customer opt-ins or other branches may use it.
        setNotice('تم إيقاف تنبيهات المدير لهذا الفرع على هذا الجهاز.')
        return
      }
      const key = await (await fetch('/api/push/public-key', { cache: 'no-store' })).json()
      if (!key.publicKey) throw new Error('إعدادات Push غير مكتملة على الخادم')
      if (!subscription) subscription = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(key.publicKey) })
      await api('/api/push/staff/subscribe', { subscription: subscription.toJSON() })
      setNotice('تم تسجيل هذا الجهاز لتنبيهات نفاد مخزون الفرع. جرّب إرسال إشعار اختباري ثم أغلق التطبيق لاختبار الاستلام.')
    } catch (err) { setNotice(err.message) }
    finally { setBusy(false) }
  }
  return <section className="mb-4 rounded-xl border border-gold/20 bg-[#191919] p-3">
    <p className="mb-2 text-sm text-gold">إشعارات هاتف المدير · الفرع المحدد فقط</p>
    <p className="mb-2 text-xs text-neutral-400">فعّلها على كل جهاز مطلوب. للمالك والمدير فقط، بما في ذلك عند إغلاق التطبيق. على iPhone أضف التطبيق إلى الشاشة الرئيسية أولاً.</p>
    <div className="flex flex-wrap gap-2">{[['enable','تفعيل Push للمدير'],['test','إرسال إشعار تجريبي'],['disable','إيقاف لهذا الفرع']].map(([kind,label]) => <button key={kind} disabled={busy} onClick={() => act(kind)} type="button" className="rounded-lg border border-gold/30 px-3 py-2 text-xs text-gold disabled:opacity-50">{label}</button>)}</div>
    {notice && <p role="status" className="mt-2 text-xs text-neutral-200">{notice}</p>}
  </section>
}
