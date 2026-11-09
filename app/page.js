'use client'

import { useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { supabase } from '@/lib/supabase'

export default function HomePage() {
  const router = useRouter()

  useEffect(() => {
    let cancelled = false

    async function checkSession() {
      const { data } = await supabase.auth.getSession()
      if (cancelled) return

      if (data.session) {
        router.replace('/dashboard')
      } else {
        router.replace('/login')
      }
    }

    checkSession()

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
