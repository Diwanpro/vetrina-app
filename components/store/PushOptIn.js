'use client'

// Branch-scoped Web Push opt-in for customers (v3.1).
// Browsers only grant permission after a user gesture, so this is a small bell
// button plus an elegant card — never a blocking automatic popup.

import { useEffect, useState } from 'react'
import { urlBase64ToUint8Array } from '@/lib/pwa/client'
import { safeStoreIcon } from '@/lib/pwa/manifest'

function initials(name) {
  return String(name || 'متجر').trim().slice(0, 2)
}

export default function PushOptIn({ slug, store }) {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [supported, setSupported] = useState(true)
  const [enabled, setEnabled] = useState(false)
  const [subscribed, setSubscribed] = useState(false)
  const [permission, setPermission] = useState('default')
  const [notice, setNotice] = useState('')
  const key = `vetrina.push-dismissed:${slug || 'store'}`

  useEffect(() => {
    if (!slug || typeof window === 'undefined') return
    if (typeof Notification === 'undefined' || !('serviceWorker' in navigator) || !('PushManager' in window)) {
      setSupported(false)
      return
    }
    let live = true
    let timer = null
    setPermission(Notification.permission)

    fetch('/api/push/public-key', { cache: 'no-store' })
      .then(response => response.json())
      .then(data => { if (live) setEnabled(Boolean(data.enabled && data.publicKey)) })
      .catch(() => {})

    navigator.serviceWorker.ready
      .then(registration => registration.pushManager.getSubscription())
      .then(subscription => { if (live && subscription) setSubscribed(true) })
      .catch(() => {})

    if (Notification.permission === 'default') {
      try {
        if (localStorage.getItem(key) !== '1') timer = window.setTimeout(() => setOpen(true), 2800)
      } catch { /* private mode */ }
    }
    return () => { live = false; if (timer) window.clearTimeout(timer) }
  }, [slug, key])

  async function registration() {
    const existing = await navigator.serviceWorker.getRegistration('/')
    if (existing) return existing
    await navigator.serviceWorker.register('/service-worker.js', { scope: '/' })
    return navigator.serviceWorker.ready
  }

  async function subscribe() {
    if (busy) return
    setBusy(true); setNotice('')
    try {
      const result = await Notification.requestPermission()
      setPermission(result)
      if (result !== 'granted') {
        setNotice('لم يُمنح إذن الإشعارات. يمكنك تفعيله لاحقاً من إعدادات المتصفح.')
        return
      }
      const keyResponse = await fetch('/api/push/public-key', { cache: 'no-store' })
      const keyData = await keyResponse.json()
      if (!keyData.enabled || !keyData.publicKey) {
        setNotice('إشعارات هذا المتجر غير مفعّلة حالياً على الخادم.')
        return
      }
      const reg = await registration()
      const previous = await reg.pushManager.getSubscription()
      if (previous) await previous.unsubscribe()
      const subscription = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(keyData.publicKey),
      })
      const response = await fetch('/api/push/subscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ slug, subscription: subscription.toJSON() }),
      })
      if (!response.ok) throw new Error('تعذر تسجيل الاشتراك')
      setSubscribed(true)
      setOpen(false)
      try { localStorage.removeItem(key) } catch { /* ignore */ }
    } catch (err) {
      setNotice(err.message || 'تعذر تفعيل الإشعارات')
    } finally {
      setBusy(false)
    }
  }

  async function unsubscribe() {
    if (busy) return
    setBusy(true); setNotice('')
    try {
      const reg = await navigator.serviceWorker.ready
      const subscription = await reg.pushManager.getSubscription()
      if (subscription) {
        await fetch('/api/push/unsubscribe', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ slug, endpoint: subscription.endpoint }),
        }).catch(() => {})
        await subscription.unsubscribe()
      }
      setSubscribed(false)
      setOpen(false)
    } catch (err) {
      setNotice(err.message || 'تعذر إيقاف الإشعارات')
    } finally {
      setBusy(false)
    }
  }

  function dismiss() {
    setOpen(false)
    try { localStorage.setItem(key, '1') } catch { /* ignore */ }
  }

  if (!supported || !store) return null
  const name = store.name || 'المتجر'
  const logo = safeStoreIcon(store.logo_url)

  return (
    <>
      {!open && (
        <button type="button" onClick={() => setOpen(true)}
          aria-label={subscribed ? 'إشعارات المتجر مفعّلة' : 'تفعيل إشعارات المتجر'}
          title={subscribed ? 'الإشعارات مفعّلة' : 'تفعيل إشعارات العروض'}
          className="vetrina-push-fab sf-pop fixed bottom-20 start-3 z-[43] relative flex h-12 w-12 items-center justify-center rounded-2xl text-xl text-gold shadow-lg active:scale-95">
          <span aria-hidden="true">{subscribed ? '🔔' : '🔕'}</span>
          {subscribed && <span className="absolute -end-0.5 -top-0.5 h-2.5 w-2.5 rounded-full bg-emerald-400" />}
        </button>
      )}

      {open && (
        <section role="dialog" aria-modal="false" aria-label="إشعارات المتجر"
          className="vetrina-push-card sf-fade-up fixed bottom-20 start-3 z-[46] w-[min(360px,calc(100vw-1.5rem))] rounded-3xl p-4 text-neutral-100">
          <div className="flex items-start gap-3">
            <div className="flex h-12 w-12 shrink-0 items-center justify-center overflow-hidden rounded-2xl border border-gold/35 bg-white/5 text-sm font-bold text-gold">
              {logo
                ? <img src={logo} alt="" className="h-full w-full object-cover" onError={event => { event.currentTarget.style.display = 'none' }} />
                : <span>{initials(name)}</span>}
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-bold text-gold">جديد {name} يصلك أولاً</p>
              <p className="mt-1 text-[11px] leading-5 text-neutral-300">
                فعّل الإشعارات لتصلك تنبيهات المنتجات الجديدة والعروض لهذا الفرع فقط، مع رابط مباشر إلى المتجر.
              </p>
            </div>
            <button type="button" onClick={dismiss} aria-label="إغلاق"
              className="shrink-0 rounded-full px-2 text-lg leading-none text-neutral-400 hover:text-neutral-100">×</button>
          </div>

          {permission === 'denied' && (
            <p className="mt-3 rounded-xl border border-amber-400/25 bg-amber-400/10 p-2 text-[11px] text-amber-200">
              الإشعارات محظورة في إعدادات المتصفح. اسمح بها لهذا الموقع ثم عد إلى هنا.
            </p>
          )}
          {!enabled && (
            <p className="mt-3 rounded-xl border border-white/10 bg-white/5 p-2 text-[11px] text-neutral-400">
              خادم الإشعارات قيد الإعداد؛ يمكنك المحاولة مرة أخرى لاحقاً.
            </p>
          )}
          {notice && <p role="status" className="mt-3 text-[11px] text-rose-200">{notice}</p>}

          <div className="mt-3 flex gap-2">
            {subscribed ? (
              <button type="button" disabled={busy} onClick={unsubscribe}
                className="flex-1 rounded-xl border border-white/15 px-4 py-2.5 text-sm text-neutral-200 disabled:opacity-50">
                {busy ? 'جاري التحديث...' : 'إيقاف الإشعارات'}
              </button>
            ) : (
              <button type="button" disabled={busy || permission === 'denied'} onClick={subscribe}
                className="flex-1 rounded-xl bg-gold px-4 py-2.5 text-sm font-bold text-[#121212] disabled:opacity-50 active:scale-[0.98]">
                {busy ? 'جاري التفعيل...' : 'تفعيل الإشعارات'}
              </button>
            )}
            <button type="button" onClick={dismiss}
              className="rounded-xl border border-white/15 px-4 py-2.5 text-sm text-neutral-300 active:scale-[0.98]">
              لاحقاً
            </button>
          </div>
        </section>
      )}
    </>
  )
}
