// Trial rules shared by the signup form, the lock screen and tests.
// The database is authoritative (`public.trial_expired`); these functions must
// stay in step with it.

export const TRIAL_EMAIL_DOMAIN = 'vetrina.app'
export const WHATSAPP_NUMBER = '0798726063'

// Maps a phone number to the synthetic login email used by the app.
// Digits only, so "0555 12 34 56" and "+213 555 12 34 56" behave predictably.
export function normalizePhone(phone) {
  return String(phone ?? '').replace(/[^0-9]/g, '')
}

// The database compares the digits of the auth email against these digits, so
// this must produce the same string the browser sends to signUp.
export function phoneToEmail(phone) {
  const digits = normalizePhone(phone)
  if (!digits) throw new Error('أدخل رقم الهاتف')
  return `${digits}@${TRIAL_EMAIL_DOMAIN}`
}

export function validateSignup({ storeName, ownerName, phone, password }) {
  const store = String(storeName ?? '').trim()
  const owner = String(ownerName ?? '').trim()
  const digits = normalizePhone(phone)
  if (!store) throw new Error('اسم المحل مطلوب')
  if (store.length > 200) throw new Error('اسم المحل طويل جداً (حتى 200 حرف)')
  if (!owner) throw new Error('اسم المالك مطلوب')
  if (owner.length > 200) throw new Error('اسم المالك طويل جداً (حتى 200 حرف)')
  if (digits.length < 8 || digits.length > 20) throw new Error('رقم الهاتف غير صالح (8 إلى 20 رقماً)')
  // Supabase requires 6 by default; ask for 8 to keep PINs and passwords apart.
  if (String(password ?? '').length < 8) throw new Error('كلمة المرور يجب أن تكون 8 أحرف على الأقل')
  if (String(password).length > 72) throw new Error('كلمة المرور طويلة جداً')
  return { storeName: store, ownerName: owner, phone: digits, email: `${digits}@${TRIAL_EMAIL_DOMAIN}`, password: String(password) }
}

// Turns the phone into the username the login screen expects.
export function usernameFromPhone(phone) {
  return normalizePhone(phone)
}

// wa.me needs an international number; Algerian mobiles are 0X XX XX XX XX.
export function whatsappLink(message, phone = WHATSAPP_NUMBER) {
  const digits = normalizePhone(phone)
  const international = digits.startsWith('0') ? `213${digits.slice(1)}` : digits
  return `https://wa.me/${international}?text=${encodeURIComponent(message)}`
}
