import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const read = p => fs.readFile(path.join(ROOT, p), 'utf8')

const modal = await read('components/dashboard/MixedPaymentModal.js')
const picker = await read('components/dashboard/CustomerPicker.js')
const boundary = await read('app/error.js')

// Every capitalised JSX component must be imported or defined in the file.
// The build cannot catch a missing import: it is a runtime ReferenceError, and
// it black-screened the till because <CustomerPicker> was never imported.
const JSX_BUILTINS = new Set(['Fragment'])

async function undefinedComponents (file) {
  const source = await read(file)
  const imported = new Set()
  for (const m of source.matchAll(/import\s+(?:(\w+)\s*,?\s*)?(?:\{([^}]*)\})?\s*from/g)) {
    if (m[1]) imported.add(m[1].trim())
    if (m[2]) for (const part of m[2].split(',')) {
      const name = part.split(' as ').pop().trim()
      if (name) imported.add(name)
    }
  }
  const declared = new Set()
  for (const m of source.matchAll(/(?:function|const|let)\s+(\w+)/g)) declared.add(m[1])
  // A capitalised tag can also arrive as a prop (`icon: Icon`) or be destructured
  // in the parameter list. Both are in scope; only a bare unknown tag is a bug.
  for (const m of source.matchAll(/(\w+)\s*:\s*([A-Z]\w*)/g)) declared.add(m[2])
  for (const m of source.matchAll(/function\s+\w+\s*\(\s*\{([^}]*)\}/g)) {
    for (const part of m[1].split(',')) declared.add(part.split(':').pop().trim())
  }

  const missing = new Set()
  for (const m of source.matchAll(/<([A-Z]\w*)/g)) {
    const name = m[1]
    if (JSX_BUILTINS.has(name)) continue
    if (!imported.has(name) && !declared.has(name)) missing.add(name)
  }
  return [...missing]
}

test('the credit modal imports every component it renders', async () => {
  // This is the crash: <CustomerPicker> rendered with no import in scope, which
  // is a ReferenceError at render time and no build error at all.
  assert.match(modal, /^import CustomerPicker from '@\/components\/dashboard\/CustomerPicker'$/m)
  assert.deepEqual(await undefinedComponents('components/dashboard/MixedPaymentModal.js'), [])
})

test('no dashboard component renders an undefined capitalised tag', async () => {
  const files = []
  async function walk (dir) {
    for (const entry of await fs.readdir(path.join(ROOT, dir), { withFileTypes: true })) {
      const next = `${dir}/${entry.name}`
      if (entry.isDirectory()) await walk(next)
      else if (entry.name.endsWith('.js')) files.push(next)
    }
  }
  await walk('components')
  await walk('app')

  const broken = []
  for (const file of files) {
    if (file.endsWith('layout.js') || file.endsWith('_screens/purchases.js')) continue
    const missing = await undefinedComponents(file)
    if (missing.length) broken.push(`${file}: ${missing.join(', ')}`)
  }
  assert.deepEqual(broken, [])
})

test('the credit path reads the customer defensively', () => {
  // Guards, not bare property access on a value that may not be resolved yet.
  assert.match(modal, /const customerName = typeof customer\?\.name === 'string' \? customer\.name\.trim\(\) : ''/)
  assert.match(modal, /const customerId = typeof customer\?\.id === 'string' && customer\.id \? customer\.id : null/)
  assert.equal(/customer\.id \|\| null/.test(modal), false, 'no unguarded id read')
})

test('a credit sale cannot be submitted before a customer is resolved', () => {
  assert.match(modal, /const creditReady = isPaper \? Boolean\(file\) : Boolean\(customerName \|\| customerId\)/)
  assert.match(modal, /disabled=\{busy \|\| !creditReady\}/)
  assert.match(modal, /اختر الزبون أولاً/)
})

test('an RPC failure shows a sentence, never a crash', () => {
  assert.match(modal, /تعذر تسجيل الدفعة، تحقق من الاتصال وأعد المحاولة/)
  // The handler must catch, log, and keep the modal open.
  assert.match(modal, /catch \(err\) \{\s+console\.error\('\[pos\] mixed payment failed', err\)/)
  assert.match(modal, /finally \{ setBusy\(false\) \}/)
})

test('the picker surfaces a failed search instead of silently showing none', async () => {
  // `const { error }` shadowed the setter, so the catch had nothing to report.
  assert.equal(/const \{ data, error \} = await supabase/.test(picker), false)
  assert.match(picker, /const \{ data, error: queryError \} = await supabase/)
  assert.match(picker, /console\.error\('\[customer-picker\] search failed', err\)/)
  assert.match(picker, /تعذر البحث عن الزبائن، تحقق من الاتصال/)
})

test('a failed search clears the list rather than leaving stale rows', () => {
  assert.match(picker, /setRows\(\[\]\)\s+setError\('تعذر البحث/)
})

test('the global boundary offers reset() and the dark theme', () => {
  assert.match(boundary, /export default function GlobalError\(\{ error, reset \}\)/)
  assert.match(boundary, /onClick=\{\(\) => reset\(\)\}/)
  assert.match(boundary, /bg-\[#171717\]/)
  assert.match(boundary, /text-gold/)
  assert.match(boundary, /إعادة المحاولة/)
})

test('boundaries exist at every level the till touches', async () => {
  const dashboard = await read('app/dashboard/error.js')
  assert.match(dashboard, /onClick=\{\(\) => reset\(\)\}/)
  const global = await read('app/global-error.js')
  // global-error replaces the root layout, so it must render its own html tag.
  assert.match(global, /<html lang="ar" dir="rtl">/)
  assert.match(global, /onClick=\{\(\) => reset\(\)\}/)
})
