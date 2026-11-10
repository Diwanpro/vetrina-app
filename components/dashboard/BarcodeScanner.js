'use client'

import { useEffect, useId, useRef, useState } from 'react'
import { Modal, Notice, fieldClass, primaryClass } from './EngineUI'

export default function BarcodeScanner({ onScan, onClose }) {
  const id = `scanner-${useId().replace(/[^a-z0-9]/gi, '')}`
  const [error, setError] = useState('')
  const [manual, setManual] = useState('')
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState('جاري تشغيل الكاميرا...')
  const callbacks = useRef({ onScan, onClose })
  callbacks.current = { onScan, onClose }
  const scannerRef = useRef(null)
  const processing = useRef(false)
  const paused = useRef(false)
  const mounted = useRef(true)

  async function detect(code) {
    if (processing.current || !code.trim()) return
    processing.current = true
    setBusy(true); setError('')
    try {
      const scanner = scannerRef.current
      if (scanner?.isScanning && !paused.current) { scanner.pause(true); paused.current = true }
      await callbacks.current.onScan(code.trim())
      if (mounted.current) callbacks.current.onClose()
    } catch (err) {
      if (mounted.current) {
        setError(err.message || 'تعذر البحث عن الباركود')
        // Leave preview paused after a failed read; avoids repeated alerts.
        setStatus('أدخل الرمز يدوياً أو أغلق النافذة وأعد المسح.')
      }
    } finally {
      processing.current = false
      if (mounted.current) setBusy(false)
    }
  }

  useEffect(() => {
    let cancelled = false
    let scanner
    mounted.current = true
    async function start() {
      try {
        const { Html5Qrcode, Html5QrcodeSupportedFormats: F } = await import('html5-qrcode')
        if (cancelled) return
        scanner = new Html5Qrcode(id, { formatsToSupport: [F.CODE_128, F.EAN_13, F.EAN_8, F.UPC_A, F.UPC_E, F.CODE_39, F.ITF, F.CODABAR], verbose: false })
        scannerRef.current = scanner
        await scanner.start({ facingMode: 'environment' }, { fps: 10, qrbox: { width: 250, height: 140 } }, code => { if (!cancelled) detect(code) }, () => {})
        if (cancelled) { if (scanner.isScanning) await scanner.stop(); scanner.clear() }
        else setStatus('وجّه الكاميرا نحو الباركود')
      } catch (err) {
        if (!cancelled) {
          setError('تعذر تشغيل الكاميرا. اسمح بالوصول إليها واستخدم HTTPS، أو أدخل الرمز يدوياً.')
          setStatus('الإدخال اليدوي متاح')
        }
      }
    }
    start()
    return () => {
      cancelled = true; mounted.current = false
      scannerRef.current = null
      if (scanner?.isScanning) scanner.stop().then(() => scanner.clear()).catch(() => {})
    }
  }, [id])

  return <Modal title="مسح الباركود" busy={busy} onClose={onClose}>
    <div id={id} className="mb-3 min-h-40 overflow-hidden rounded-xl bg-black" />
    <p role="status" className="mb-3 text-xs text-neutral-400">{busy ? 'جاري البحث عن المقاس...' : status}</p>
    <Notice error={error} />
    <form onSubmit={e => { e.preventDefault(); detect(manual) }} className="space-y-3">
      <label className="block text-sm">الباركود يدوياً<input autoFocus dir="ltr" disabled={busy} required value={manual} onChange={e => setManual(e.target.value)} className={`${fieldClass} mt-1`} /></label>
      <button disabled={busy || !manual.trim()} className={`${primaryClass} w-full`}>إضافة للسلة</button>
    </form>
  </Modal>
}
