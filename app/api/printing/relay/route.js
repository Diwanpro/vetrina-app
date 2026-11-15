// Server-side ESC/POS print middleware relay (P5).
//
// The browser POSTs raw bytes to THIS relative route. The route forwards them
// only to PRINT_MIDDLEWARE_URL configured on the server; a client can never
// choose an arbitrary destination. No secret value is ever returned or logged.

export const runtime = 'nodejs'

const MAX_BYTES = 65536

function error(message, status) {
  return Response.json({ ok: false, error: message }, { status })
}

export async function POST(request) {
  let body
  try { body = await request.json() } catch { return error('طلب طباعة غير صالح', 400) }
  const list = Array.isArray(body?.bytes) ? body.bytes : null
  if (!list || !list.length || list.length > MAX_BYTES ||
      list.some(value => !Number.isInteger(value) || value < 0 || value > 255)) {
    return error('بيانات ESC/POS غير صالحة', 400)
  }
  const raw = String(process.env.PRINT_MIDDLEWARE_URL || '').trim()
  if (!raw) {
    return error('وسيط الطباعة غير مضبوط. أضف PRINT_MIDDLEWARE_URL في متغيرات الخادم أو استخدم WebUSB / WebBluetooth / طباعة المتصفح.', 503)
  }
  let url
  try { url = new URL(raw) } catch { return error('عنوان وسيط الطباعة على الخادم غير صالح', 500) }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return error('وسيط الطباعة يجب أن يستخدم http أو https', 500)

  const headers = { 'Content-Type': 'application/octet-stream' }
  const token = String(process.env.PRINT_MIDDLEWARE_TOKEN || '').trim()
  if (token) headers['X-Print-Token'] = token

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: Uint8Array.from(list),
      signal: AbortSignal.timeout(8000),
      cache: 'no-store',
    })
    if (!response.ok) return error(`رفض وسيط الطباعة الطلب (${response.status})`, 502)
    return Response.json({ ok: true })
  } catch {
    return error('تعذر الاتصال بوسيط الطباعة. تأكد من تشغيله وأن العنوان قابل للوصول من الخادم.', 502)
  }
}
