'use client'

// One mount point for the customer-facing PWA (v3.1):
//   * swaps the static dashboard manifest for the BRANCH's dynamic manifest;
//   * registers the canonical /service-worker.js once;
//   * shows the elegant install prompt and the branch-scoped push opt-in.
//
// No table access, no service key and no browser-default dropdown here.

import { useEffect } from 'react'
import InstallPrompt from './InstallPrompt'
import PushOptIn from './PushOptIn'
import { manifestHref, safeStoreIcon } from '@/lib/pwa/client'

export default function StorePwa({ slug, store }) {
  useEffect(() => {
    if (!slug || typeof document === 'undefined') return
    const href = manifestHref(slug)
    const links = [...document.querySelectorAll('link[rel="manifest"]')]
    if (links.length) {
      links.forEach((link, index) => {
        if (index === 0) link.setAttribute('href', href)
        else link.remove()
      })
    } else {
      const link = document.createElement('link')
      link.rel = 'manifest'
      link.href = href
      document.head.appendChild(link)
    }

    const logo = safeStoreIcon(store?.logo_url)
    if (logo) {
      const apple = document.querySelector('link[rel="apple-touch-icon"]')
      if (apple) apple.setAttribute('href', logo)
      const icon = document.querySelector('link[rel="icon"]')
      if (icon) icon.setAttribute('href', logo)
    }

    if ('serviceWorker' in navigator && process.env.NODE_ENV === 'production') {
      navigator.serviceWorker.register('/service-worker.js', { scope: '/' }).catch(() => {})
    }
  }, [slug, store?.logo_url])

  if (!store) return null
  return (
    <>
      <InstallPrompt slug={slug} store={store} />
      <PushOptIn slug={slug} store={store} />
    </>
  )
}
