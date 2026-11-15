'use client'

// POS receipt modal: 58mm/80mm thermal widths and four transports. Every new
// dropdown uses the shared «الدرج المنزلق» CustomSelect, never a native select.

import { useMemo, useState } from 'react'
import CustomSelect from '@/components/ui/CustomSelect'
import {
  RECEIPT_WIDTH_OPTIONS, RECEIPT_TRANSPORT_OPTIONS, normalizeReceipt,
  receiptLines, formatDzd,
} from '@/lib/printing/receipt'
import {
  canUseWebUsb, canUseWebBluetooth, printViaBrowser, printViaMiddleware,
  printViaWebBluetooth, printViaWebUsb, receiptBytes,
} from '@/lib/printing/transports'

export default function ReceiptPrinter({ receipt, onClose }) {
  const [width, setWidth] = useState('80mm')
  const [transport, setTransport] = useState('browser')
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')
  const [error, setError] = useState('')
  const data = useMemo(() => normalizeReceipt({ ...receipt, width }), [receipt, width])
  const lines = useMemo(() => receiptLines(data), [data])

  async function print() {
    setBusy(true); setError(''); setNotice('')
    try {
      if (transport === 'browser') {
        printViaBrowser(data)
      } else {
        const bytes = receiptBytes(data, width)
        if (transport === 'webusb') await printViaWebUsb(bytes)
        else if (transport === 'webbluetooth') await printViaWebBluetooth(bytes)
        else if (transport === 'middleware') await printViaMiddleware(bytes, { width })
        else throw new Error('وسيلة طباعة غير معروفة')
      }
      setNotice('أُرسل الإيصال إلى الطابعة.')
    } catch (err) {
      setError(err.message || 'تعذر طباعة الإيصال')
    } finally { setBusy(false) }
  }

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/80 p-4">
      <section role="dialog" aria-modal="true" aria-label="طباعة إيصال نقطة البيع"
        className="w-full max-w-md rounded-2xl border border-gold/25 bg-[#171717] p-4 text-neutral-100 shadow-2xl">
        <div className="mb-3 flex items-center justify-between gap-3">
          <div>
            <h2 className="text-sm font-medium text-gold">طباعة الإيصال</h2>
            <p className="mt-0.5 text-[11px] text-neutral-500">فاتورة {data.number} · {formatDzd(data.total)}</p>
          </div>
          <button type="button" onClick={onClose} disabled={busy} className="text-xs text-neutral-400 disabled:opacity-50">إغلاق</button>
        </div>

        <div className="mb-3 grid gap-2 sm:grid-cols-2">
          <div>
            <span className="mb-1 block text-xs text-neutral-400">عرض الورقة الحرارية</span>
            <CustomSelect value={width} onChange={setWidth} options={RECEIPT_WIDTH_OPTIONS}
              disabled={busy} aria-label="عرض الورقة الحرارية"
              className="w-full rounded-lg border border-[#D4AF37]/40 bg-[#1A1A1A] px-3 py-2 text-sm" />
          </div>
          <div>
            <span className="mb-1 block text-xs text-neutral-400">وسيلة الطباعة</span>
            <CustomSelect value={transport} onChange={setTransport} options={RECEIPT_TRANSPORT_OPTIONS}
              disabled={busy} aria-label="وسيلة الطباعة"
              className="w-full rounded-lg border border-[#D4AF37]/40 bg-[#1A1A1A] px-3 py-2 text-sm" />
          </div>
        </div>

        <div className="mb-3 max-h-44 overflow-y-auto rounded-lg border border-white/10 bg-black/30 p-2 font-mono text-[10px] leading-5 text-neutral-400" dir="ltr">
          {lines.map((line, index) => (
            <div key={index} className={line.align === 'center' ? 'text-center' : line.align === 'right' ? 'text-right' : 'text-left'}>
              {line.text}
            </div>
          ))}
        </div>

        <p className="mb-3 text-[11px] leading-5 text-neutral-500">
          WebUSB و WebBluetooth يحتاجان HTTPS وضغطة مستخدم. وسيط الطباعة يُضبط من متغير الخادم <code dir="ltr">PRINT_MIDDLEWARE_URL</code>.
          النص العربي يُشكّل كاملاً في طباعة المتصفح، ويُكتب بحروف لاتينية آمنة في ESC/POS.
        </p>
        <p className="mb-3 text-[11px] text-neutral-500">
          {canUseWebUsb() ? 'WebUSB متاح' : 'WebUSB غير متاح في هذا المتصفح'} · {canUseWebBluetooth() ? 'WebBluetooth متاح' : 'WebBluetooth غير متاح في هذا المتصفح'}
        </p>

        {error && <p role="alert" className="mb-2 rounded border border-red-500/30 bg-red-950/30 p-2 text-xs text-red-200">{error}</p>}
        {notice && <p role="status" className="mb-2 rounded border border-emerald-700/30 bg-emerald-950/30 p-2 text-xs text-emerald-200">{notice}</p>}

        <div className="flex gap-2">
          <button type="button" disabled={busy} onClick={print}
            className="flex-1 rounded-lg bg-gold px-4 py-2.5 text-sm font-medium text-[#121212] disabled:opacity-60">
            {busy ? 'جاري الطباعة...' : 'طباعة الإيصال'}
          </button>
          <button type="button" disabled={busy} onClick={onClose}
            className="rounded-lg border border-white/10 px-4 py-2.5 text-sm text-neutral-300 disabled:opacity-50">إغلاق</button>
        </div>
      </section>
    </div>
  )
}
