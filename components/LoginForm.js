'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { getAppContext } from '@/lib/app-context'
import { supabase } from '@/lib/supabase'

function Logo() {
  return (
    <img
      src="/vetrina_logo_main.png"
      alt="Vetrina"
      width="150"
      height="150"
      className="w-[150px] h-auto rounded-2xl shadow-[0_8px_24px_rgba(212,175,55,0.28)]"
    />
  )
}

export default function LoginForm() {
  const router = useRouter()
  const [username, setUsername] = useState('')
  const [pin, setPin] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  async function handleLogin(e) {
    e.preventDefault()
    setError('')
    setLoading(true)

    const email =
      username.trim().toLowerCase() === 'admin'
        ? 'admin@staff.vetrina.dz'
        : `${username.trim().toLowerCase()}@staff.vetrina.dz`

    const { error: authError } = await supabase.auth.signInWithPassword({
      email,
      password: pin,
    })

    if (authError) {
      setLoading(false)
      setError('بيانات الدخول غير صحيحة')
      return
    }

    try {
      await getAppContext() // Cache verified profile and check subscription before entry.
      router.push('/dashboard') // Layout displays the lock screen when expired.
    } catch (err) { setError(err.message) }
    finally { setLoading(false) }
  }

  return (
    <main className="relative min-h-screen flex flex-col items-center justify-center px-4 py-8">
      <div className="w-full max-w-md mx-auto bg-card rounded-2xl border border-white/5 px-5 py-8 shadow-[0_8px_32px_rgba(0,0,0,0.45)]">
        <div className="flex flex-col items-center mb-7">
          <Logo />
          <h1 className="mt-3 text-3xl font-bold tracking-[0.18em] text-gold">
            VETRINA
          </h1>
          <p className="mt-1 text-[10px] tracking-[0.28em] uppercase text-neutral-500">
            ATTIA WEB SOLUTION
          </p>
        </div>

        <form onSubmit={handleLogin} className="space-y-4">
          <div>
            <label htmlFor="username" className="mb-1.5 block text-sm text-neutral-400">
              اسم المستخدم
            </label>
            <input
              id="username"
              type="text"
              autoComplete="username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              className="w-full rounded-lg border border-neutral-700 bg-[#141414] px-3 py-2.5 text-base text-neutral-100 outline-none transition focus:border-gold"
              required
            />
          </div>

          <div>
            <label htmlFor="pin" className="mb-1.5 block text-sm text-neutral-400">
              رمز PIN
            </label>
            <input
              id="pin"
              type="password"
              inputMode="numeric"
              autoComplete="current-password"
              value={pin}
              onChange={(e) => setPin(e.target.value)}
              className="w-full rounded-lg border border-neutral-700 bg-[#141414] px-3 py-2.5 text-base text-neutral-100 outline-none transition focus:border-gold"
              required
            />
          </div>

          <button
            type="submit"
            disabled={loading}
            className="mt-2 w-full rounded-lg bg-gold py-2.5 text-base font-medium text-[#121212] transition hover:bg-[#c4a030] disabled:opacity-60"
          >
            {loading ? 'جاري الدخول...' : 'تسجيل الدخول'}
          </button>
        </form>
      </div>

      {error && (
        <div className="fixed top-4 left-1/2 z-50 w-[calc(100%-2rem)] max-w-md -translate-x-1/2 rounded-lg border border-red-500/30 bg-red-950/90 px-4 py-2.5 text-center text-sm text-red-200 shadow-lg">
          {error}
        </div>
      )}

      <p className="absolute bottom-4 left-0 right-0 text-center text-[11px] text-neutral-500">
        للدعم: 0798726063 | attiawebsite@gmail.com
      </p>
    </main>
  )
}
