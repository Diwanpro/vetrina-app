// Isolated UI test for the dashboard's new bottom sheet, rendered for real with
// esbuild + JSDOM — no new dependency, no network, no DOM assertions on a
// string. The component under test is the real
// components/dashboard/BottomSheet.js; the harness mirrors product-add-ui.test.mjs.
import test, { afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { JSDOM } from 'jsdom'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://local.test/dashboard/pos' })
for (const key of ['window','document','HTMLElement','HTMLButtonElement','Node','Event','KeyboardEvent','MouseEvent','MutationObserver']) globalThis[key] = dom.window[key]
Object.defineProperty(globalThis,'navigator',{value:dom.window.navigator, configurable:true})
globalThis.IS_REACT_ACT_ENVIRONMENT = true

const React = await import('react')
const { createRoot } = await import('react-dom/client')
const { act } = React

const outfile = path.join(process.cwd(), '.cache', 'dashboard-bottom-sheet', 'BottomSheet.mjs')
await build({
  entryPoints: [path.join(process.cwd(), 'components/dashboard/BottomSheet.js')],
  outfile,
  bundle: true,
  platform: 'node',
  format: 'esm',
  jsx: 'automatic',
  loader: { '.js': 'jsx' },
  external: ['react','react-dom','react-dom/client','react/jsx-runtime'],
})
const BottomSheet = (await import(pathToFileURL(outfile))).default

const pickerOut = path.join(process.cwd(), '.cache', 'dashboard-bottom-sheet', 'PaymentMethodPicker.mjs')
await build({
  entryPoints: [path.join(process.cwd(), 'components/dashboard/PaymentMethodPicker.js')],
  outfile: pickerOut,
  bundle: true,
  platform: 'node',
  format: 'esm',
  jsx: 'automatic',
  loader: { '.js': 'jsx' },
  external: ['react','react-dom','react-dom/client','react/jsx-runtime'],
})
const PaymentMethodPicker = (await import(pathToFileURL(pickerOut))).default

let container
let root
let pickerRoot
// Created once per test: a plain counter object would be recreated by the
// re-render the close itself triggers, which would hide the very call we assert.
const counter = { wasClosed: 0, setOpen: null }
function Harness({ children }) {
  const [open, setOpen] = React.useState(true)
  counter.setOpen = setOpen
  return React.createElement(BottomSheet, {
    open,
    onClose: () => { counter.wasClosed += 1; setOpen(false) },
    title: 'طريقة الدفع',
  }, children)
}
function render() {
  act(() => {
    root = createRoot(container)
    root.render(React.createElement(Harness, null, React.createElement('p', null, 'محتوى الدرج')))
  })
}
afterEach(() => {
  // Unmount the React root, not the DOM node: only the root tears down effects,
  // and a leaked window listener would make the next test count another's close.
  act(() => { root?.unmount?.() })
  act(() => { pickerRoot?.unmount?.() })
  root = null
  pickerRoot = null
  container = null
  counter.wasClosed = 0
  counter.setOpen = null
  document.body.innerHTML = ''
  document.body.style.overflow = ''
})

async function mount() {
  container = document.createElement('div')
  document.body.appendChild(container)
  render()
  // The scroll lock and the Escape listener live in effects, which React flushes
  // asynchronously; flush them (and the re-render they cause) before asserting
  // on behaviour.
  await act(async () => {})
  return container
}
const scrim = () => document.querySelector('button[aria-label="إغلاق"]:not([role="option"])')
const dialog = () => document.querySelector('[role="dialog"]')

test('closed: renders nothing, so it cannot cover the screen', async () => {
  await mount()
  await act(async () => { counter.setOpen(false) })
  assert.equal(document.body.textContent, '')
  assert.equal(dialog(), null)
})

test('open: a labelled dialog with a title and a close button', async () => {
  await mount()
  const panel = dialog()
  assert.ok(panel, 'dialog exists')
  assert.equal(panel.getAttribute('aria-modal'), 'true')
  assert.equal(panel.getAttribute('aria-labelledby'), 'bottom-sheet-title')
  assert.equal(panel.querySelector('#bottom-sheet-title').textContent, 'طريقة الدفع')
  assert.equal(panel.textContent.includes('محتوى الدرج'), true)
  assert.ok([...panel.querySelectorAll('button')].some(button => button.getAttribute('aria-label') === 'إغلاق'), 'close button labelled')
  assert.ok(scrim(), 'scrim is a labelled button')
  assert.equal(panel.className.includes('rounded-t-2xl'), true, 'sheet grows from the bottom edge')
})

test('Escape closes the sheet and restores page scroll', async () => {
  await mount()
  assert.equal(document.body.style.overflow, 'hidden', 'scroll locked while open')
  await act(async () => { dom.window.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
  assert.equal(counter.wasClosed, 1, 'onClose fired once on Escape')
  assert.equal(dialog(), null, 'sheet unmounted after close')
  assert.equal(document.body.style.overflow, '', 'scroll lock released')
})

test('tap on the scrim closes; a tap inside the panel does not', async () => {
  await mount()
  await act(async () => { dialog().dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })) })
  assert.equal(counter.wasClosed, 0, 'an inside tap is not an outside tap')
  await act(async () => { scrim().dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })) })
  assert.equal(counter.wasClosed, 1, 'onClose fired on the scrim')
  assert.equal(dialog(), null)
})

test('focus moves into the sheet while it is open', async () => {
  await mount()
  assert.equal(document.activeElement.closest('[role="dialog"]') !== null, true, 'focus is inside the dialog')
})

// --- Static guards: the cashier must use the sheet, and nothing else may. ---
import fs from 'node:fs/promises'
const posPage = await fs.readFile(new URL('../app/dashboard/pos/page.js', import.meta.url), 'utf8')
const picker = await fs.readFile(new URL('../components/dashboard/PaymentMethodPicker.js', import.meta.url), 'utf8')

test('the cashier pays through the bottom sheet, not a popup dropdown', () => {
  assert.match(posPage, /import PaymentMethodPicker from '@\/components\/dashboard\/PaymentMethodPicker'/)
  assert.match(posPage, /<PaymentMethodPicker\s+value=\{payment\}\s+onChange=\{setPayment\}/)
  // The picker renders its own labelled block, so no wrapper is left behind.
  assert.doesNotMatch(posPage, /<div className="mb-2 block">\s*<PaymentMethodPicker/)
  // Only the payment method was converted; the page has no other dropdown left.
  assert.doesNotMatch(posPage, /CustomSelect/)
})

test('the picker keeps the three methods and the cashier keeps its default', () => {
  assert.match(posPage, /const \[payment, setPayment\] = useState\('cash'\)/)
  assert.match(posPage, /value: 'cash', label: 'نقداً'/)
  assert.match(posPage, /value: 'check', label: 'شيك'/)
  assert.match(posPage, /value: 'ccp', label: 'CCP'/)
  assert.match(picker, /onChange\(option\.value\); setOpen\(false\)/)
})

// --- The picker itself: open it, see the three methods, pick one. ---
const METHODS = [
  { value: 'cash', label: 'نقداً' },
  { value: 'check', label: 'شيك' },
  { value: 'ccp', label: 'CCP' },
]
let chosen
function PickerHarness() {
  const [value, setValue] = React.useState('cash')
  chosen = { value, setValue }
  return React.createElement(PaymentMethodPicker, { value, onChange: setValue, options: METHODS })
}
function mountPicker() {
  container = document.createElement('div')
  document.body.appendChild(container)
  act(() => {
    pickerRoot = createRoot(container)
    pickerRoot.render(React.createElement(PickerHarness))
  })
  act(() => {})
  return container
}

test('the picker shows the current method and opens a sheet of the three', async () => {
  mountPicker()
  assert.match(document.body.textContent, /نقداً/, 'current method is shown closed')
  const trigger = document.querySelector('button[aria-haspopup="dialog"]')
  assert.ok(trigger, 'the closed control is a dialog trigger')
  await act(async () => { trigger.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })) })
  const options = [...document.querySelectorAll('[role="option"]')]
  assert.deepEqual(options.map(option => option.textContent.replace('✓', '').trim()), ['نقداً', 'شيك', 'CCP'])
  assert.equal(options[0].getAttribute('aria-selected'), 'true')
})

test('choosing a method reports it once and closes the sheet', async () => {
  mountPicker()
  const trigger = document.querySelector('button[aria-haspopup="dialog"]')
  await act(async () => { trigger.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })) })
  const ccp = [...document.querySelectorAll('[role="option"]')].find(option => option.textContent.includes('CCP'))
  await act(async () => { ccp.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })) })
  assert.equal(chosen.value, 'ccp')
  assert.equal(document.querySelector('[role="dialog"]'), null, 'sheet closed after the choice')
  assert.match(document.body.textContent, /CCP/, 'the control now shows the chosen method')
})

test('the picker is disabled with its trigger, and never writes a sale', async () => {
  container = document.createElement('div')
  document.body.appendChild(container)
  act(() => {
    pickerRoot = createRoot(container)
    pickerRoot.render(React.createElement(PaymentMethodPicker, { value: 'cash', onChange: () => {}, options: METHODS, disabled: true }))
  })
  act(() => {})
  const trigger = document.querySelector('button[aria-haspopup="dialog"]')
  assert.equal(trigger.disabled, true)
  await act(async () => { trigger.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })) })
  assert.equal(document.querySelector('[role="dialog"]'), null, 'a disabled picker opens nothing')
})
