export const SALARY_TYPES = { fixed: 'راتب أساسي', commission: 'عمولة', daily: 'يومية' }
export function licenseBranches(key, mode) {
  const match = key.trim().match(/^(VTR|UPG)-([1-9][0-9]{0,9})-([A-Za-z0-9-]+)$/)
  if (!match || key.trim().length > 200 || match[1] !== mode || Number(match[2]) > 2147483647) throw new Error('مفتاح غير صالح. تحقق من نوع المفتاح وعدد الفروع.')
  return Number(match[2])
}
export function canAddBranch(count, limit) {
  return Number.isInteger(count) && count >= 0 && Number.isInteger(limit) && limit > 0 && count < limit
}
export function validateHr({ firstName, lastName, salaryType, salaryAmount }) {
  if (!firstName?.trim() || !lastName?.trim() || firstName.trim().length > 100 || lastName.trim().length > 100 || !Object.hasOwn(SALARY_TYPES, salaryType) || salaryAmount == null || salaryAmount === '' || !Number.isSafeInteger(Number(salaryAmount)) || Number(salaryAmount) < 0 || Number(salaryAmount) > 2147483647) throw new Error('أدخل الاسم واللقب ونوع الأجر والمبلغ الصحيح غير السالب')
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
