'use client'

import { useCallback, useEffect, useState } from 'react'
import { supabase } from '@/lib/supabase'
import { productImage } from '@/lib/storefront'

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
      // Normalise the pictures here as well as in SQL. The RPC now resolves
      // image_url through first_image_url(), but this client must not depend on
      // that migration having been applied: a look item whose product has only
      // images[] would otherwise draw an empty square, which is exactly the bug
      // that prompted this. productImage() is the same rule, so the two agree.
      const list = (Array.isArray(data) ? data : [])
        .filter(look => look && (look.items || []).length > 0)
        .map(look => ({
          ...look,
          image_url: productImage(look),
          items: (look.items || []).map(item => ({ ...item, image_url: productImage(item) })),
        }))
      setLooks(list)
    } catch (err) {
      // Expected on a database that has not had migration 012 applied yet.
      console.error('[storefront] looks unavailable', err)
      setLooks([])
    } finally { setLoading(false) }
  }, [slug])

  useEffect(() => { load() }, [load])

  return { looks, loading, reload: load }
}
