'use client'

import { useEffect, useRef, useState } from 'react'
import { speechResultText, appendDictation } from '@/lib/voice'

// Final results append to the latest field value; interim speech never overwrites
// typed text. Each session owns its recognition instance and releases the mic.
export default function VoiceInput({ value = '', onChange, disabled = false, lang = 'ar-DZ', maxLength = 4000 }) {
  const [supported, setSupported] = useState(false)
  const [listening, setListening] = useState(false)
  const [interim, setInterim] = useState('')
  const [error, setError] = useState('')
  const recognition = useRef(null)
  const current = useRef({ value, onChange })
  current.current = { value, onChange }

  useEffect(() => {
    setSupported(Boolean(window.webkitSpeechRecognition || window.SpeechRecognition))
    return () => {
      const instance = recognition.current
      recognition.current = null
      if (instance) {
        instance.onresult = null; instance.onerror = null; instance.onend = null; instance.onstart = null
        instance.abort()
      }
    }
  }, [])
  useEffect(() => {
    if (disabled && recognition.current) {
      const instance = recognition.current
      recognition.current = null
      instance.onresult = null; instance.onerror = null; instance.onend = null
      instance.abort()
      setListening(false); setInterim('')
    }
  }, [disabled])

  function toggle() {
    if (disabled) return
    if (recognition.current) { recognition.current.stop(); return }
    const SpeechRecognition = window.webkitSpeechRecognition || window.SpeechRecognition
    if (!SpeechRecognition) return
    const instance = new SpeechRecognition()
    recognition.current = instance
    const processed = new Set()
    instance.lang = lang
    instance.continuous = true
    instance.interimResults = true
    setError(''); setInterim(''); setListening(true)
    instance.onresult = event => {
      if (recognition.current !== instance) return
      const { final, interim: pending } = speechResultText(event.results, processed)
      if (final.trim()) {
        const previous = current.current.value || ''
        const next = appendDictation(previous, final, maxLength)
        current.current = { ...current.current, value: next }
        current.current.onChange(next)
      }
      setInterim(pending.trim())
    }
    instance.onerror = event => {
      if (recognition.current !== instance || event.error === 'aborted') return
      const messages = {
        'not-allowed': 'اسمح بالوصول إلى الميكروفون من إعدادات المتصفح.',
        'service-not-allowed': 'خدمة الإملاء غير متاحة في هذا المتصفح.',
        'audio-capture': 'لم يتم العثور على ميكروفون متاح.',
        'no-speech': 'لم يتم التقاط كلام. حاول مرة أخرى.',
        network: 'تعذر الاتصال بخدمة الإملاء. تحقق من الإنترنت.',
      }
      setError(messages[event.error] || 'تعذر الإملاء الصوتي. يمكنك الكتابة يدوياً.')
    }
    instance.onend = () => {
      if (recognition.current === instance) { recognition.current = null; setListening(false); setInterim('') }
    }
    try { instance.start() }
    catch { recognition.current = null; setListening(false); setError('تعذر تشغيل الميكروفون. حاول مرة أخرى.') }
  }

  return <div className="text-xs">
    <button type="button" onClick={toggle} disabled={disabled || !supported} aria-pressed={listening}
      aria-label={listening ? 'إيقاف الإملاء الصوتي' : 'إملاء الوصف بالصوت'}
      title={supported ? 'إملاء صوتي بالعربية' : 'الإملاء غير مدعوم في هذا المتصفح؛ يمكنك الكتابة يدوياً'}
      className={`inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-2 disabled:opacity-40 ${listening ? 'border-red-500/60 bg-red-950/30 text-red-200' : 'border-gold/30 bg-gold/10 text-gold'}`}>
      <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><rect x="9" y="2" width="6" height="12" rx="3" /><path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3M8 22h8" /></svg>
      {listening ? 'إيقاف التسجيل' : 'إملاء صوتي'}
    </button>
    <span role="status" aria-live="polite" className="mt-1 block text-neutral-500">{listening ? interim || 'أستمع إليك… تحدث بالعربية ثم اضغط إيقاف.' : !supported ? 'الإملاء غير مدعوم هنا؛ الكتابة اليدوية متاحة.' : ''}</span>
    {error && <p role="alert" className="mt-1 text-red-300">{error}</p>}
  </div>
}
