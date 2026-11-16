export const LOGO_MAX_BYTES = 2 * 1024 * 1024
export const LOGO_TYPES = ['image/jpeg', 'image/png', 'image/webp']
export function validateStoreLogo(file) {
  if (!file || !LOGO_TYPES.includes(file.type)) return 'صيغة الشعار غير مدعومة. استخدم JPG أو PNG أو WebP، وليس HEIC أو SVG.'
  if (!file.size) return 'ملف الشعار فارغ.'
  if (file.size > LOGO_MAX_BYTES) return 'حجم الشعار يتجاوز 2 ميغابايت. صغّر الصورة ثم أعد المحاولة.'
  return null
}
export function logoUploadError(error) {
  const text = String(error?.message || '')
  if (/size|large|limit/i.test(text)) return 'حجم الشعار يتجاوز الحد المسموح (2 ميغابايت).'
  if (/mime|type/i.test(text)) return 'صيغة غير مدعومة؛ استخدم JPG أو PNG أو WebP.'
  if (/policy|permission|row.level|unauthorized/i.test(text)) return 'ليس لديك إذن رفع شعار لهذا الفرع. تحقق من حساب المالك أو المدير.'
  if (/bucket.*not found/i.test(text)) return 'مجلد شعارات الفروع غير مهيأ على الخادم. تواصل مع الدعم.'
  return `تعذر رفع الشعار: ${text || 'تحقق من الاتصال ثم أعد المحاولة.'}`
}
