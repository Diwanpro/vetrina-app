import { createClient } from '@supabase/supabase-js'

// A client for the public storefront's server-side metadata.
//
// lib/supabase.js creates its client at module scope, which throws during
// `next build` when the environment has no Supabase keys — the dashboard never
// hits this because those pages are client components. This one is created on
// first use and refuses to throw: a missing key costs a page title, never a
// build or a page.
let client = null

export function publicStoreClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  if (!url || !key) return null
  if (!client) {
    client = createClient(url, key, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { headers: { 'x-client-info': 'vetrina-storefront' } },
    })
  }
  return client
}

/** Runs a public RPC and never throws: the caller decides what a failure means. */
export async function publicRpc(fn, args) {
  const supabase = publicStoreClient()
  if (!supabase) return { data: null, error: null }
  try {
    return await supabase.rpc(fn, args)
  } catch (error) {
    return { data: null, error }
  }
}
