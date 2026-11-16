// Browser-side fire-and-forget bridge to the server push dispatcher (v3.1).
// Called after a NEW product or a promotional offer is saved in the dashboard.
// A missing session, an offline device or an unconfigured server never blocks
// the merchant's save flow.

export async function notifyBranchPush({ storeId, kind, name }) {
  try {
    if (typeof window === 'undefined' || !storeId) return null
    const { supabase } = await import('@/lib/supabase')
    const { data } = await supabase.auth.getSession()
    const token = data?.session?.access_token
    if (!token) return null
    const response = await fetch('/api/push/dispatch', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        storeId,
        kind,
        name: String(name || '').slice(0, 120),
      }),
    })
    if (!response.ok) return null
    return await response.json()
  } catch {
    return null
  }
}
