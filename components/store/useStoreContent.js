'use client'

import { useEffect, useState } from 'react'

const EMPTY = { banners: [], sections: [] }
const RENEW_MS = 4 * 60 * 1000 // Signed for 5 minutes; refresh before lazy images expire.

export default function useStoreContent(slug, store) {
  const [snapshot, setSnapshot] = useState(null)
  const activeSlug = slug?.trim().toLowerCase()
  const scope = activeSlug && store?.slug === activeSlug && store.store_id ? `${store.store_id}:${activeSlug}` : null

  useEffect(() => {
    setSnapshot(null)
    if (!scope) return
    let live = true, pending = null, timer, dueAt = 0
    async function refresh() {
      if (!live || document.hidden || pending) return
      window.clearTimeout(timer)
      pending = new AbortController()
      const timeout = window.setTimeout(() => pending?.abort(), 12000)
      let delay = RENEW_MS
      try {
        const response = await fetch(`/api/store/${encodeURIComponent(activeSlug)}/content`, {
          cache: 'no-store', credentials: 'omit', signal: pending.signal,
        })
        if (!response.ok) throw new Error('Content unavailable')
        const { banners, sections } = await response.json()
        if (live) setSnapshot({ scope, banners: Array.isArray(banners) ? banners : [], sections: Array.isArray(sections) ? sections : [] })
      } catch {
        delay = 30000
        if (live) setSnapshot(null) // Optional content never enters the catalogue's error/loading state.
      } finally {
        window.clearTimeout(timeout)
        pending = null
        if (live) { dueAt = Date.now() + delay; timer = window.setTimeout(refresh, delay) }
      }
    }
    const resume = () => { if (Date.now() >= dueAt) refresh() }
    refresh()
    document.addEventListener('visibilitychange', resume)
    window.addEventListener('online', refresh)
    return () => {
      live = false; pending?.abort(); window.clearTimeout(timer)
      document.removeEventListener('visibilitychange', resume); window.removeEventListener('online', refresh)
    }
  }, [activeSlug, scope])

  // An expired/deleted object may still have had a URL. Drop only that image;
  // a late error from a previous slug or signature cannot remove a new one.
  function dropImage(url) {
    setSnapshot(old => !old || old.scope !== scope ? old : { ...old,
      banners: old.banners.filter(item => item.imageUrl !== url), sections: old.sections.filter(item => item.imageUrl !== url),
    })
  }
  const content = scope && snapshot?.scope === scope ? snapshot : EMPTY
  return { banners: content.banners, sections: content.sections, dropImage }
}
