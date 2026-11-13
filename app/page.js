'use client'

import { useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { supabase } from '@/lib/supabase'

/**
 * The site root is a router, never a page.
 *
 * A shop's public page lives at /s/<slug>; nothing here may fall through to it,
 * because an owner opening their domain expects the dashboard, and a stranger
 * opening it expects the login screen — not somebody else's shop.
 *
 * Two details matter for the "it defaults to the public store" report:
 *   * the redirect is decided from the stored session, not from a fetch that
 *     can hang, so a slow or offline network cannot leave someone parked here;
 *   * `replace`, not `push`, so the back button never returns to a page that
 *     immediately bounces again.
 */
export default function HomePage() {
  const router = useRouter()

  useEffect(() => {
    let cancelled = false
    const go = path => { if (!cancelled) router.replace(path) }

    // An offline session still counts: the POS is usable without a network, and
    // bouncing to /login would strand a cashier mid-shift.
    if (typeof navigator !== 'undefined' && !navigator.onLine && localStorage.getItem('vetrina.auth')) {
      go('/dashboard/pos')
      return () => { cancelled = true }
    }

    supabase.auth.getSession()
      .then(({ data }) => go(data?.session ? '/dashboard' : '/login'))
      // A thrown error (no keys configured, a bad response) is also "not
      // signed in"; /login is the safe destination either way.
      .catch(() => go('/login'))

    return () => { cancelled = true }
  }, [router])

  return (
    <main className="flex min-h-screen items-center justify-center px-4">
      <p className="text-sm text-neutral-500">جاري التحميل...</p>
    </main>
  )
}
