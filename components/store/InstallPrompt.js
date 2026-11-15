'use client'

// Elegant, customer-facing PWA install prompt (v3.1).
// It never hijacks the first paint: the card appears after a short delay, is
// dismissible per branch, and follows the store's feminine/classic palette.

import { useEffect, useRef, useState } from 'react'
import { isIosSafari, isStandalone } from '@/lib/pwa/client'
import { safeStoreIcon } from '@/lib/pwa/manifest'

function initials(name) {
  return String(name || 'متجر').trim().slice(0, 2)
}

export default function InstallPrompt({ slug, store }) {
  const [visible, setVisible] = useState(false)
  const [ios, setIos] = useState(false)
  const deferred = useRef(null)
  const key = `vetrina.install-dismissed:${slug || 'store'}`

  useEffect(() => {
    if (!slug || typeof window === 'undefined' || isStandalone()) return
    let timer = null
    try {
      if (localStorage.getItem(key) === '1') return
    } catch { /* storage can be disabled in private mode */ }

    const show = () => { timer = window.setTimeout(() => setVisible(true), 1400) }
    const onBeforeInstall = event => {
      event.preventDefault()
      deferred.current = event
      show()
    }
    const onInstalled = () => {
      setVisible(false)
      try { localStorage.setItem(key, '1') } catch { /* ignore */ }
    }
    window.addEventListener('beforeinstallprompt', onBeforeInstall)
    window.addEventListener('appinstalled', onInstalled)
    if (isIosSafari()) {
      setIos(true)
      timer = window.setTimeout(() => setVisible(true), 2000)
    }
    return () => {
      window.removeEventListener('beforeinstallprompt', onBeforeInstall)
      window.removeEventListener('appinstalled', onInstalled)
      if (timer) window.clearTimeout(timer)
    }
  }, [slug, key])

  function dismiss() {
    setVisible(false)
    try { localStorage.setItem(key, '1') } catch { /* ignore */ }
  }

  async function install() {
    if (!deferred.current) return
    try {
      await deferred.current.prompt()
      await deferred.current.userChoice
    } finally {
      deferred.current = null
      setVisible(false)
    }
  }

  if (!visible || !store) return null
  const name = store.name || 'المتجر'
  const logo = safeStoreIcon(store.logo_url)

  return (
    <aside role="dialog" aria-label="تثبيت المتجر" aria-modal="false"
      className="vetrina-install-card sf-fade-up fixed inset-x-3 bottom-36 z-[44] mx-auto max-w-md rounded-3xl p-4 text-neutral-100">
      <div className="flex items-start gap-3">
        <div className="flex h-12 w-12 shrink-0 items-center justify-center overflow-hidden rounded-2xl border border-gold/35 bg-white/5 text-sm font-bold text-gold">
          {logo
            ? <img src={logo} alt="" className="h-full w-full object-cover" onError={event => { event.currentTarget.style.display = 'none' }} />
            : <span>{initials(name)}</span>}
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-bold text-gold">ثبّت متجر {name} على هاتفك</p>
          <p className="mt-1 text-[11px] leading-5 text-neutral-300">
            {ios
              ? 'على iPhone: اضغط زر المشاركة ثم «إضافة إلى الشاشة الرئيسية» لتفتح المتجر كتطبيق.'
              : 'افتح المتجر مباشرة من الشاشة الرئيسية، وتابع المنتجات الجديدة والعروض دون البحث عن الرابط.'}
          </p>
        </div>
        <button type="button" onClick={dismiss} aria-label="إغلاق"
          className="shrink-0 rounded-full px-2 text-lg leading-none text-neutral-400 hover:text-neutral-100">×</button>
      </div>
      <div className="mt-3 flex gap-2">
        {!ios && (
          <button type="button" onClick={install}
            className="flex-1 rounded-xl bg-gold px-4 py-2.5 text-sm font-bold text-[#121212] active:scale-[0.98]">
            تثبيت الآن
          </button>
        )}
        <button type="button" onClick={dismiss}
          className="rounded-xl border border-white/15 px-4 py-2.5 text-sm text-neutral-300 active:scale-[0.98]">
          {ios ? 'حسناً' : 'لاحقاً'}
        </button>
      </div>
    </aside>
  )
}
