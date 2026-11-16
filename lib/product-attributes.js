// Stable Unicode scalar ordering, shared with PostgreSQL COLLATE "C" (UTF-8).
export function normalizeColorComponents(input) {
  if (!Array.isArray(input) || input.length < 1 || input.length > 6) throw new Error('اختر من لون واحد إلى ستة ألوان')
  const values = input.map(value => {
    if (typeof value !== 'string') throw new Error('مكوّن لون غير صالح')
    const clean = value.replace(/^ +| +$/g, '')
    if (!clean || [...clean].length > 40 || /[\u0000-\u001f\u007f]/u.test(clean)) throw new Error('اسم اللون: من 1 إلى 40 حرفاً دون محارف تحكم')
    return clean
  })
  if (new Set(values).size !== values.length) throw new Error('مكونات اللون مكررة')
  return values.sort((a, b) => {
    const x = [...a].map(c => c.codePointAt(0)), y = [...b].map(c => c.codePointAt(0))
    for (let i = 0; i < Math.min(x.length, y.length); i++) if (x[i] !== y[i]) return x[i] - y[i]
    return x.length - y.length
  })
}
export const sizeLabel = size => size === 'ONE_SIZE' ? 'مقاس موحد' : (size || 'موحّد')
export const colorLabel = components => normalizeColorComponents(components).join(' / ')
