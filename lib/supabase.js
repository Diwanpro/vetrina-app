import { createClient } from '@supabase/supabase-js'

export const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
  { global: { fetch: async (url, options = {}) => {
    const controller = new AbortController()
    const abort = () => controller.abort()
    if (options.signal?.aborted) controller.abort()
    options.signal?.addEventListener('abort', abort, { once: true })
    const timer = setTimeout(abort, 20000)
    try { return await fetch(url, { ...options, signal: controller.signal }) }
    finally { clearTimeout(timer); options.signal?.removeEventListener('abort', abort) }
  } } }
)

if (typeof window !== 'undefined') {
  supabase.auth.onAuthStateChange(event => {
    if (event === 'SIGNED_IN') window.dispatchEvent(new Event('vetrina:auth'))
    if (event === 'SIGNED_OUT') {
      localStorage.removeItem('vetrina.auth')
      if (location.pathname.startsWith('/dashboard')) location.assign('/login')
    }
  })
}
