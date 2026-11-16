/* Vetrina canonical service worker (v3.1).
 * Shell/assets only: never cache Supabase, auth, /api data or mutations.
 * Also owns Web Push display and notification-click routing.
 */
const CACHE = 'vetrina-store-v5'
const SHELL = [
  '/offline.html',
  '/logo.png',
  '/icon-192.png',
  '/icon-512.png',
  '/manifest.json',
]

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE)
      .then(cache => cache.addAll(SHELL))
      .catch(() => {})
  )
  self.skipWaiting()
})

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys
        .filter(key => (key.startsWith('vetrina-shell-') || key.startsWith('vetrina-store-v')) && key !== CACHE)
        .map(key => caches.delete(key))))
      .then(() => self.clients.claim())
  )
})

self.addEventListener('message', event => {
  if (event.data?.type !== 'CACHE_ASSETS') return
  const urls = (event.data.urls || []).filter(value => {
    try {
      const url = new URL(value, self.location.origin)
      return url.origin === self.location.origin && (
        url.pathname.startsWith('/_next/static/') ||
        url.pathname.startsWith('/s/') ||
        url.pathname === '/dashboard/pos' ||
        url.pathname === '/dashboard'
      )
    } catch { return false }
  })
  event.waitUntil(caches.open(CACHE).then(cache =>
    Promise.all(urls.map(url => cache.add(url).catch(() => {})))))
})

self.addEventListener('fetch', event => {
  const request = event.request
  const url = new URL(request.url)
  if (request.method !== 'GET' || url.origin !== self.location.origin) return
  // Dynamic manifests, push routes and all data APIs stay network-only.
  if (url.pathname.startsWith('/api/')) return

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request).then(response => {
        if (response.ok && (
          url.pathname.startsWith('/dashboard') ||
          url.pathname.startsWith('/s/') ||
          url.pathname === '/login'
        )) {
          const copy = response.clone()
          event.waitUntil(caches.open(CACHE).then(cache => cache.put(request, copy)))
        }
        return response
      }).catch(async () =>
        (await caches.match(request, { ignoreSearch: true })) || caches.match('/offline.html'))
    )
  } else if (
    url.pathname.startsWith('/_next/static/') ||
    SHELL.includes(url.pathname)
  ) {
    event.respondWith(
      caches.match(request).then(cached => cached || fetch(request).then(response => {
        if (response.ok) {
          const copy = response.clone()
          event.waitUntil(caches.open(CACHE).then(cache => cache.put(request, copy)))
        }
        return response
      }))
    )
  }
})

self.addEventListener('push', event => {
  let payload = {}
  try {
    payload = event.data ? event.data.json() : {}
  } catch {
    payload = { title: 'Vetrina', body: event.data ? event.data.text() : '' }
  }
  const title = String(payload.title || 'Vetrina').slice(0, 120)
  const url = String(payload.url || payload.data?.url || '/').slice(0, 600)
  const options = {
    body: String(payload.body || '').slice(0, 400),
    icon: String(payload.icon || '/icon-192.png').slice(0, 600),
    badge: '/icon-192.png',
    tag: String(payload.tag || 'vetrina-update').slice(0, 120),
    data: { url },
    actions: [{ action: 'open', title: url.startsWith('/dashboard/alerts') ? 'فتح التنبيهات' : 'افتح المتجر' }],
  }
  event.waitUntil(self.registration.showNotification(title, options))
})

self.addEventListener('notificationclick', event => {
  event.notification.close()
  const target = event.notification.data?.url || '/'
  event.waitUntil((async () => {
    const windows = await clients.matchAll({ type: 'window', includeUncontrolled: true })
    for (const client of windows) {
      if ('focus' in client) {
        await client.focus()
        if ('navigate' in client) {
          try { await client.navigate(target) } catch { /* same-origin only */ }
        }
        return
      }
    }
    if (clients.openWindow) await clients.openWindow(target)
  })())
})

self.addEventListener('pushsubscriptionchange', event => {
  // VAPID rotation: ask every open store tab to resubscribe on its next visit.
  event.waitUntil((async () => {
    const windows = await clients.matchAll({ type: 'window', includeUncontrolled: true })
    await Promise.all(windows.map(client => client.postMessage({ type: 'PUSH_RESUBSCRIBE' })))
  })())
})
