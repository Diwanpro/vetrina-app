export const DENOMINATIONS = [2000, 1000, 500, 200, 100]
export const FLOOR_PRICE_MESSAGE = 'عذراً، لا يمكن البيع بأقل من السعر الأدنى بدون موافقة المدير'
export function validMoney(value) {
  return value !== '' && Number.isSafeInteger(Number(value)) && Number(value) >= 0
}
export function meetsFloor(price, minimum) {
  return validMoney(price) && Number(price) >= Number(minimum || 0)
}
export function countCash(counts) {
  return DENOMINATIONS.reduce((sum, denomination) => sum + denomination * Number(counts[denomination] || 0), 0)
}
export function todayRange(now = new Date()) {
  const start = new Date(now)
  start.setHours(0, 0, 0, 0)
  const end = new Date(start)
  end.setDate(end.getDate() + 1)
  return { from: start.toISOString(), to: end.toISOString() }
}
// Supabase caps responses; page through financial rows rather than silently undercounting.
export async function fetchAllRows(query) {
  const rows = []
  for (let offset = 0; ; offset += 1000) {
    const { data, error } = await query.range(offset, offset + 999)
    if (error) throw error
    rows.push(...(data || []))
    if (!data || data.length < 1000) return rows
  }
}
