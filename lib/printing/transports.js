// Browser transports for POS receipts (P5): WebUSB, WebBluetooth, a server-side
// print middleware relay, and a browser-shaped Arabic fallback.
//
// WebUSB/WebBluetooth require HTTPS and a user gesture, so they are started only
// from the «طباعة الإيصال» button. The middleware relay never accepts a URL from
// the browser; it forwards bytes to the server-side PRINT_MIDDLEWARE_URL only.

import { buildEscPosBytes } from './escpos.js'
import { receiptHtml } from './receipt.js'

export function canUseWebUsb() {
  return typeof navigator !== 'undefined' && Boolean(navigator.usb)
}

export function canUseWebBluetooth() {
  return typeof navigator !== 'undefined' && Boolean(navigator.bluetooth)
}

function printerEndpoint(device) {
  const configuration = device.configuration
  if (!configuration) return null
  for (const iface of configuration.interfaces || []) {
    const alternate = iface.alternates?.[0] || iface.alternate
    const endpoints = alternate?.endpoints || []
    const out = endpoints.find(endpoint => endpoint.direction === 'out' && endpoint.type === 'bulk')
    if (out) return { interfaceNumber: iface.interfaceNumber, endpointNumber: out.endpointNumber }
  }
  return null
}

export async function printViaWebUsb(bytes) {
  if (!canUseWebUsb()) throw new Error('WebUSB غير مدعوم في هذا المتصفح. استخدم Chrome/Edge عبر HTTPS أو طباعة المتصفح.')
  const device = await navigator.usb.requestDevice({ filters: [] })
  await device.open()
  if (!device.configuration) await device.selectConfiguration(1)
  const target = printerEndpoint(device)
  if (!target) { await device.close().catch(() => {}); throw new Error('لم أجد منفذ طباعة Bulk OUT على طابعة USB المختارة.') }
  await device.claimInterface(target.interfaceNumber)
  try {
    await device.transferOut(target.endpointNumber, bytes)
  } finally {
    await device.releaseInterface(target.interfaceNumber).catch(() => {})
    await device.close().catch(() => {})
  }
}

// Common serial/printing GATT services used by cheap ESC/POS thermal printers.
export const BLUETOOTH_PRINT_SERVICES = Object.freeze([
  '000018f0-0000-1000-8000-00805f9b34fb',
  '0000ff00-0000-1000-8000-00805f9b34fb',
  '0000ffe0-0000-1000-8000-00805f9b34fb',
  '49535343-fe7d-4ae5-8fa9-9fafd205e455',
])

async function writableCharacteristic(server) {
  const services = await server.getPrimaryServices()
  for (const service of services) {
    const characteristics = await service.getCharacteristics()
    const target = characteristics.find(characteristic =>
      characteristic.properties?.write || characteristic.properties?.writeWithoutResponse)
    if (target) return target
  }
  return null
}

export async function printViaWebBluetooth(bytes) {
  if (!canUseWebBluetooth()) throw new Error('WebBluetooth غير مدعوم في هذا المتصفح. استخدم Chrome/Edge عبر HTTPS أو طباعة المتصفح.')
  const device = await navigator.bluetooth.requestDevice({
    acceptAllDevices: true,
    optionalServices: [...BLUETOOTH_PRINT_SERVICES],
  })
  const server = await device.gatt.connect()
  try {
    const characteristic = await writableCharacteristic(server)
    if (!characteristic) throw new Error('لم أجد خاصية كتابة على طابعة Bluetooth المختارة.')
    // 20 bytes is safe for the default BLE ATT MTU; larger printers accept more.
    for (let offset = 0; offset < bytes.length; offset += 20) {
      const chunk = bytes.slice(offset, offset + 20)
      if (characteristic.writeValueWithoutResponse) await characteristic.writeValueWithoutResponse(chunk)
      else await characteristic.writeValue(chunk)
    }
  } finally {
    device.gatt.disconnect()
  }
}

export async function printViaMiddleware(bytes, { width = '80mm', endpoint = '/api/printing/relay' } = {}) {
  const response = await fetch(endpoint, {
    method: 'POST',
    cache: 'no-store',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ bytes: Array.from(bytes), width }),
  })
  const body = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(body.error || `تعذر إرسال الإيصال إلى وسيط الطباعة (${response.status})`)
  return body
}

export function printViaBrowser(receipt) {
  if (typeof document === 'undefined') throw new Error('طباعة المتصفح تحتاج نافذة متصفح.')
  const iframe = document.createElement('iframe')
  iframe.setAttribute('aria-hidden', 'true')
  iframe.style.position = 'fixed'
  iframe.style.right = '0'
  iframe.style.bottom = '0'
  iframe.style.width = '0'
  iframe.style.height = '0'
  iframe.style.border = '0'
  iframe.srcdoc = receiptHtml(receipt)
  iframe.onload = () => {
    try {
      iframe.contentWindow?.focus()
      iframe.contentWindow?.print()
    } finally {
      window.setTimeout(() => iframe.remove(), 1200)
    }
  }
  document.body.appendChild(iframe)
  return true
}

export function receiptBytes(receipt, width = '80mm') {
  return buildEscPosBytes(receipt, { width })
}
