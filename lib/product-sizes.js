export const SIZE_TYPES = [
  { value: 'clothing', label: 'ملابس', sizes: ['S', 'M', 'L', 'XL', 'XXL'] },
  { value: 'shoes', label: 'أحذية', sizes: ['39', '40', '41', '42', '43', '44', '45'] },
  { value: 'pants', label: 'سراويل', sizes: ['38', '40', '42', '44', '46', '48'] },
]

export function sizesForType(type) {
  return SIZE_TYPES.find(option => option.value === type)?.sizes || SIZE_TYPES[0].sizes
}

export function emptySizeRow(sizes) {
  return Object.fromEntries(sizes.map(size => [size, '']))
}

export function emptySizeMatrix(colors, sizes) {
  return Object.fromEntries(colors.map(color => [color, emptySizeRow(sizes)]))
}

// Only the active size type can produce variants, even if stale keys exist.
export function filledSizeCells(matrix, sizes) {
  const cells = []
  for (const [color, row] of Object.entries(matrix)) {
    for (const size of sizes) {
      const qty = Number(row[size] ?? '')
      if (!Number.isSafeInteger(qty) || qty < 0) {
        throw new Error('يجب أن تكون الكميات أعداداً صحيحة غير سالبة')
      }
      if (qty > 0) cells.push({ color, size, qty })
    }
  }
  return cells
}
