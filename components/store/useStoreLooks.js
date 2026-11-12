'use client'

import { useCallback, useEffect, useState } from 'react'
import { supabase } from '@/lib/supabase'

/**
 * The shop's published looks.
 *
 * Reads through get_store_looks(), which resolves the store by slug and only
 * then returns its looks — the storefront has no table access at all. A failure
 * here must not take the catalogue down with it: a shop with no looks, or an
 * RPC that errors, simply shows no looks tab.
 */
export default function useStoreLooks(slug) {
  const [looks, setLooks] = useState([])
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    if (!slug) { setLoading(false); return }
    setLoading(true)
    try {
      const { data, error } = await supabase.rpc('get_store_looks', { p_slug: slug })
      if (error) throw error
      setLooks(Array.isArray(data) ? data.filter(look => look && (look.items || []).length > 0) : [])
    } catch (err) {
      // Expected on a database that has not had migration 012 applied yet.
      console.error('[storefront] looks unavailable', err)
      setLooks([])
    } finally { setLoading(false) }
  }, [slug])

  useEffect(() => { load() }, [load])

  return { looks, loading, reload: load }
}
