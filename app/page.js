'use client'

import { useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { supabase } from '@/lib/supabase'

export default function HomePage() {
  const router = useRouter()

  useEffect(() => {
    let cancelled = false

    async function checkSession() {
      if (!navigator.onLine && localStorage.getItem('vetrina.auth')) { router.replace('/dashboard/pos'); return }
      const { data, error } = await supabase.auth.getSession()
      if (error) { if (!cancelled) router.replace('/login'); return }
      if (cancelled) return

      if (data.session) {
        router.replace('/dashboard')
      } else {
        router.replace('/login')
      }
    }

    checkSession().catch(() => { if (!cancelled) router.replace('/login') })

    return () => {
      cancelled = true
    }
  }, [router])

  return (
    <main className="min-h-screen flex items-center justify-center px-4">
      <p className="text-sm text-neutral-500">جاري التحميل...</p>
    </main>
  )
}
