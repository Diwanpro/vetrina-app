// Delivery pricing helpers, shared by the public checkout and the tests.
//
// The stored table is supposed to look like {"16": 400}, but real shops type
// it by hand: "9", "016", "Blida", "البليدة", 400.5, "400". The checkout must
// never silently show a fee of 0 because a key was written differently, so the
// lookup normalises both sides before comparing. The SQL repair migration
// 202611120008 applies the same rules to whatever is already stored.

import { WILAYAS } from './wilayas.js'

// Arabic diacritics, tatweel, and the letter variants that people mix up.
const MARKS = /[\u0610-\u061A\u064B-\u065F\u0670\u06D6-\u06EF\u0640]/g

/** "البليدة " and "بليدة" become the same key: "البليده". */
export function normalizeWilayaName(value) {
  return String(value ?? '')
    .replace(MARKS, '')
    .replace(/[أإآٱ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .replace(/[^\p{L}\p{N}]+/gu, '')
    .toLowerCase()
}

/** "بليده" without the article, so "بليدة" and "البليدة" both resolve. */
const keyWithoutArticle = value => value.replace(/^ال/, '')

const NAMES = new Map()
for (const wilaya of WILAYAS) {
  const full = normalizeWilayaName(wilaya.name)
  NAMES.set(full, wilaya.code)
  NAMES.set(keyWithoutArticle(full), wilaya.code)
}

/** '16', 16, '016', 'wilaya 16', 'البليدة', '16 - البليدة' -> '16'. */
export function wilayaCodeOf(value) {
  const raw = String(value ?? '').trim()
  if (!raw) return ''

  const digits = raw.match(/[0-9]{1,3}/)
  if (digits) {
    const number = Number(digits[0])
    if (Number.isInteger(number) && number >= 1 && number <= 58) {
      return String(number).padStart(2, '0')
    }
  }

  const name = normalizeWilayaName(raw)
  if (!name) return ''
  return NAMES.get(name) || NAMES.get(keyWithoutArticle(name)) || ''
}

const PRICE_KEYS = ['price', 'fee', 'amount', 'cost', 'delivery_fee', 'value']

/** 400, "400", "400 دج", {price: 400} -> 400. Anything else -> null. */
function toAmount(value) {
  if (value == null || typeof value === 'boolean') return null
  if (typeof value === 'object') {
    for (const key of PRICE_KEYS) {
      if (value[key] != null) return toAmount(value[key])
    }
    return null
  }
  const digits = String(value).replace(/[^\d.-]/g, '')
  if (!/[0-9]/.test(digits)) return null
  const number = Number(digits)
  if (!Number.isFinite(number) || number < 0 || number > 1000000) return null
  return Math.round(number)
}

/**
 * Turns whatever `stores.delivery_rates` holds into { '16': 400 }.
 * jsonb is parsed by supabase-js, but a string or a nested object is accepted
 * too, so a hand-edited row can never blank the checkout.
 */
export function normalizeDeliveryRates(rates) {
  if (!rates) return {}

  let source = rates
  if (typeof source === 'string') {
    try { source = JSON.parse(source) } catch { return {} }
  }
  if (typeof source !== 'object' || Array.isArray(source)) return {}

  // Mirrors the SQL repair: a key that is already the canonical two-digit code
  // wins over a hand-typed name for the same wilaya, and within each group the
  // keys are visited in sorted order. Both sides then agree on the result even
  // when a row was written by hand twice.
  const entries = Object.entries(source)
    .map(([key, value]) => ({
      code: wilayaCodeOf(key),
      amount: toAmount(value),
      canonical: /^[0-9]{2}$/.test(key.trim()),
      key,
    }))
    .filter(entry => entry.code && entry.amount != null)
    .sort((left, right) => {
      if (left.canonical !== right.canonical) return left.canonical ? -1 : 1
      return left.key < right.key ? -1 : (left.key > right.key ? 1 : 0)
    })

  const table = {}
  for (const entry of entries) {
    if (!(entry.code in table)) table[entry.code] = entry.amount
  }
  return table
}

/** The fee for a wilaya, or null when this shop does not deliver there. */
export function deliveryFeeFor(rates, wilaya) {
  const code = wilayaCodeOf(wilaya)
  if (!code) return null
  const table = normalizeDeliveryRates(rates)
  return Object.prototype.hasOwnProperty.call(table, code) ? table[code] : null
}
