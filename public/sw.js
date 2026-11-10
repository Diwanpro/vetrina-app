/* Shell/assets only. Never cache Supabase, auth requests, API data or mutations. */
const CACHE = 'vetrina-shell-v3'
self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(['/offline.html', '/icon.svg', '/icon-192.png', '/icon-512.png', '/manifest.json'])))
  self.skipWaiting()
})
self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key.startsWith('vetrina-shell-') && key !== CACHE).map(key => caches.delete(key)))).then(() => self.clients.claim()))
})
self.addEventListener('message', event => {
  if (event.data?.type !== 'CACHE_ASSETS') return
  const urls = (event.data.urls || []).filter(value => {
    try { const url = new URL(value, self.location.origin); return url.origin === self.location.origin && (url.pathname.startsWith('/_next/static/') || url.pathname === '/dashboard/pos' || url.pathname === '/dashboard') } catch { return false }
  })
  event.waitUntil(caches.open(CACHE).then(cache => Promise.all(urls.map(url => cache.add(url).catch(() => {})))))
})
self.addEventListener('fetch', event => {
  const request = event.request, url = new URL(request.url)
  if (request.method !== 'GET' || url.origin !== self.location.origin) return
  if (request.mode === 'navigate') {
    event.respondWith(fetch(request).then(response => {
      if (response.ok && (url.pathname.startsWith('/dashboard') || url.pathname === '/login')) {
        const copy = response.clone(); event.waitUntil(caches.open(CACHE).then(cache => cache.put(request, copy)))
      }
      return response
    }).catch(async () => (await caches.match(request, { ignoreSearch: true })) || caches.match('/offline.html')))
  } else if (url.pathname.startsWith('/_next/static/') || ['/icon.svg', '/icon-192.png', '/icon-512.png', '/manifest.json'].includes(url.pathname)) {
    event.respondWith(caches.match(request).then(cached => cached || fetch(request).then(response => {
      if (response.ok) { const copy = response.clone(); event.waitUntil(caches.open(CACHE).then(cache => cache.put(request, copy))) }
      return response
    })))
  }
})
