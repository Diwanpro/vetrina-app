// ESC/POS byte builder for 58mm / 80mm thermal printers (P5).
// No new dependency: TextEncoder + Uint8Array only. Arabic text is converted
// through latinFallback() because most receipt printers use PC437 and do not
// shape Arabic; the browser transport renders the Arabic original.

import { receiptLines, latinFallback, receiptWidth } from './receipt.js'

export const ESC_POS = Object.freeze({
  INIT: [0x1b, 0x40],
  CODEPAGE_PC437: [0x1b, 0x74, 0x00],
  ALIGN_LEFT: [0x1b, 0x61, 0x00],
  ALIGN_CENTER: [0x1b, 0x61, 0x01],
  ALIGN_RIGHT: [0x1b, 0x61, 0x02],
  BOLD_ON: [0x1b, 0x45, 0x01],
  BOLD_OFF: [0x1b, 0x45, 0x00],
  FEED: [0x0a],
  PARTIAL_CUT: [0x1d, 0x56, 0x42, 0x00],
})

const encoder = new TextEncoder()

function bytes(values) { return Uint8Array.from(values) }

function concat(chunks) {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) { out.set(chunk, offset); offset += chunk.length }
  return out
}

export function wrapText(text, width) {
  const clean = latinFallback(text)
  if (clean.length <= width) return [clean]
  const parts = []
  let rest = clean
  while (rest.length > width) {
    const slice = rest.slice(0, width)
    const breakAt = slice.lastIndexOf(' ')
    const cut = breakAt > Math.floor(width / 2) ? breakAt : width
    parts.push(rest.slice(0, cut).trimEnd())
    rest = rest.slice(cut).trimStart()
  }
  if (rest) parts.push(rest)
  return parts
}

function alignLine(text, align, width) {
  if (align === 'center') return text.slice(0, width).padStart(Math.floor((width + text.length) / 2), ' ').padEnd(width, ' ')
  if (align === 'right') return text.slice(0, width).padStart(width, ' ')
  return text.slice(0, width).padEnd(width, ' ')
}

export function buildEscPosBytes(receipt, options = {}) {
  const config = receiptWidth(options.width || receipt?.width)
  const chars = Math.max(24, Math.min(64, Number(options.chars) || config.chars))
  const chunks = [
    bytes(ESC_POS.INIT),
    bytes(ESC_POS.CODEPAGE_PC437),
  ]
  for (const line of receiptLines({ ...receipt, width: config.value })) {
    const bold = line.bold ? bytes(ESC_POS.BOLD_ON) : bytes(ESC_POS.BOLD_OFF)
    const align = line.align === 'center' ? bytes(ESC_POS.ALIGN_CENTER)
      : line.align === 'right' ? bytes(ESC_POS.ALIGN_RIGHT) : bytes(ESC_POS.ALIGN_LEFT)
    for (const part of wrapText(line.text, chars)) {
      chunks.push(bold, align, encoder.encode(alignLine(part, line.align, chars)), bytes(ESC_POS.FEED))
    }
  }
  chunks.push(bytes(ESC_POS.BOLD_OFF), bytes(ESC_POS.ALIGN_LEFT), bytes([0x0a, 0x0a]), bytes(ESC_POS.PARTIAL_CUT))
  return concat(chunks)
}
