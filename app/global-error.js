'use client'

import { useEffect } from 'react'

// Last resort: replaces the root layout, so it must render its own <html>.
export default function GlobalError({ error, reset }) {
  useEffect(() => { console.error('[app] fatal client error', error) }, [error])

  return <html lang="ar" dir="rtl">
    <body style={{ margin: 0, background: '#121212', color: '#f5f5f5', fontFamily: 'system-ui, sans-serif' }}>
      <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
        <div style={{ maxWidth: 420, width: '100%', border: '1px solid rgba(212,175,55,0.25)', borderRadius: 16, padding: 24 }}>
          <h1 style={{ color: '#D4AF37', fontSize: 18, margin: 0 }}>تعذر تشغيل التطبيق</h1>
          <p style={{ marginTop: 12, fontSize: 14, lineHeight: 1.8, color: '#c9c9c9' }}>
            حدث خطأ غير متوقع. بياناتك المحفوظة لم تتأثر.
          </p>
          <button type="button" onClick={() => reset()}
            style={{ marginTop: 16, padding: '10px 16px', borderRadius: 8, border: 0, background: '#D4AF37', color: '#121212', fontSize: 14, fontWeight: 600 }}>
            إعادة المحاولة
          </button>
        </div>
      </div>
    </body>
  </html>
}
