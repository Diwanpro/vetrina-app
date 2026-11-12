// Social video links attached to a product.
//
// Merchants paste whatever their phone shares: full URLs, share links with
// tracking parameters, or a bare "tiktok.com/@shop/video/123". These helpers
// make that one safe string and tell the storefront which platform to name.

const PLATFORMS = [
  { key: 'tiktok', label: 'تيك توك', hosts: ['tiktok.com', 'vm.tiktok.com', 'vt.tiktok.com'] },
  { key: 'instagram', label: 'إنستغرام', hosts: ['instagram.com', 'instagr.am'] },
  { key: 'facebook', label: 'فيسبوك', hosts: ['facebook.com', 'fb.com', 'fb.watch', 'm.facebook.com'] },
  { key: 'youtube', label: 'يوتيوب', hosts: ['youtube.com', 'youtu.be', 'm.youtube.com'] },
]

/**
 * A link safe to put in an href, or '' when it is not a web link at all.
 * Bare hosts get https://; javascript:, data: and friends are rejected.
 */
export function safeVideoUrl(value) {
  const raw = String(value ?? '').trim()
  if (!raw) return ''
  const candidate = /^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : `https://${raw}`
  let url
  try {
    url = new URL(candidate)
  } catch {
    return ''
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return ''
  if (!url.hostname.includes('.')) return ''
  return url.toString()
}

export function videoPlatform(value) {
  const href = safeVideoUrl(value)
  if (!href) return { key: '', label: '' }
  let host = ''
  try {
    host = new URL(href).hostname.toLowerCase().replace(/^www\./, '')
  } catch {
    return { key: '', label: '' }
  }
  const match = PLATFORMS.find(platform =>
    platform.hosts.some(candidate => host === candidate || host.endsWith(`.${candidate}`)))
  return match ? { key: match.key, label: match.label } : { key: 'other', label: 'الرابط' }
}

/** "شاهد الفيديو على تيك توك" when the platform is known, else a generic label. */
export function videoButtonLabel(value, prefix = 'شاهد الفيديو') {
  const platform = videoPlatform(value)
  if (!platform.key || platform.key === 'other') return prefix
  return `${prefix} على ${platform.label}`
}
