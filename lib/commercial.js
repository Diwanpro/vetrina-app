export const SALARY_TYPES = { fixed: 'أساسي', commission: 'عمولة', fixed_commission: 'أساسي + عمولة', daily: 'يومي' }
export function licenseBranches(key, mode) {
  const match = key.trim().match(/^(VTR|UPG)-([1-9][0-9]{0,9})-([A-Za-z0-9-]+)$/)
  if (!match || key.trim().length > 200 || match[1] !== mode || Number(match[2]) > 2147483647) throw new Error('مفتاح غير صالح. تحقق من نوع المفتاح وعدد الفروع.')
  return Number(match[2])
}
export function canAddBranch(count, limit) {
  return Number.isInteger(count) && count >= 0 && Number.isInteger(limit) && limit > 0 && count < limit
}
export function salaryFields(type) {
  return { amount: ['fixed', 'fixed_commission', 'daily'].includes(type), commission: ['commission', 'fixed_commission'].includes(type) }
}
export function salaryPayload({ salaryType, salaryAmount, commissionPercentage }) {
  const fields = salaryFields(salaryType)
  const amount = fields.amount ? Number(salaryAmount) : 0
  const percentage = fields.commission ? Number(commissionPercentage) : 0
  if (!Object.hasOwn(SALARY_TYPES, salaryType) || (fields.amount && (salaryAmount == null || String(salaryAmount).trim() === '')) || !Number.isSafeInteger(amount) || amount < 0 || amount > 2147483647 || (fields.commission && (commissionPercentage == null || String(commissionPercentage).trim() === '')) || !Number.isFinite(percentage) || percentage < 0 || percentage > 100 || Math.abs(percentage * 100 - Math.round(percentage * 100)) > 0.000001) throw new Error('أدخل مبلغاً صحيحاً غير سالب ونسبة عمولة من 0 إلى 100 (حتى منزلتين عشريتين)')
  return { salaryAmount: amount, commissionPercentage: percentage }
}
export function validateHr(form) {
  if (!form.firstName?.trim() || !form.lastName?.trim() || form.firstName.trim().length > 100 || form.lastName.trim().length > 100) throw new Error('أدخل الاسم واللقب (حتى 100 حرف)')
  salaryPayload(form)
}
export const RECEIPT_TYPES = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'application/pdf': 'pdf' }
export function validateReceipt(file) {
  if (file && (!Object.hasOwn(RECEIPT_TYPES, file.type) || file.size <= 0 || file.size > 5 * 1024 * 1024)) throw new Error('الإيصال: JPG / PNG / WebP / PDF حتى 5 ميغابايت')
}
export function distribution(data) {
  return [
    { label: 'تكلفة البضاعة', value: Number(data.costOfGoods), color: '#a38743' },
    { label: 'المصاريف', value: Number(data.expenses), color: '#78716c' },
    { label: 'الرواتب والسلف', value: Number(data.salaries) + Number(data.advances), color: '#c97d45' },
    { label: 'الربح', value: Math.max(0, Number(data.netProfit)), color: '#d4af37' },
  ].map(item => ({ ...item, value: Math.max(0, item.value || 0) }))
}
