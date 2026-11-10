// Device & session registry backed by `public.user_sessions`.
//
// Schema facts this code depends on (verified against the live database):
//   id uuid PK, user_id uuid -> auth.users(id) ON DELETE CASCADE,
//   device_fingerprint text NOT NULL, device_name text, last_active timestamptz,
//   is_active boolean, UNIQUE(user_id, device_fingerprint).
//
// That UNIQUE constraint is why this file *upserts* instead of inserting: a
// logged-out device keeps its row, so a plain INSERT would fail with 23505 the
// second time the same device signs in.

// Requirement: at most two active sessions per user; a third device evicts the
// least recently used one.
export const MAX_ACTIVE_SESSIONS = 2

// Only these columns are ever requested. `user_id` is included so callers can
// confirm the row belongs to the signed-in user before acting on it.
const COLUMNS = 'id, user_id, device_fingerprint, device_name, last_active, is_active'

function fail(message) { throw new Error(message) }

// Picks the session to evict: oldest `last_active` first. A NULL last_active
// sorts first because a row that never reported activity is the stalest.
export function selectOldestSession(sessions, fingerprint) {
  const others = (sessions || []).filter(row => row.device_fingerprint !== fingerprint)
  if (!others.length) return null
  return others.reduce((oldest, row) => {
    if (!oldest) return row
    const a = row.last_active ? new Date(row.last_active).getTime() : 0
    const b = oldest.last_active ? new Date(oldest.last_active).getTime() : 0
    if (a !== b) return a < b ? row : oldest
    // Deterministic tie-break so two devices cannot ping-pong evictions.
    return String(row.id) < String(oldest.id) ? row : oldest
  }, null)
}

// Reference model of the eviction policy, mirrored by `engine_session_register`.
//
// The authoritative implementation is the SQL function: the browser can no
// longer write user_sessions, so nothing here can be bypassed or trusted. This
// copy exists so the policy is documented and unit-tested in one place; keep
// the two in sync when the rules change.
//   'touch'  - fingerprint already registered and active: just update last_active
//   'revive' - fingerprint registered but logged out: re-activate that row
//   'insert' - new device and there is room
//   'evict'  - new device, at the cap: deactivate `evict` then insert
export function planSession(existing, fingerprint, max = MAX_ACTIVE_SESSIONS) {
  if (!fingerprint) fail('بصمة الجهاز غير صالحة')
  const rows = existing || []
  const mine = rows.find(row => row.device_fingerprint === fingerprint)
  if (mine?.is_active) return { action: 'touch', session: mine }
  if (mine) return { action: 'revive', session: mine }

  const active = rows.filter(row => row.is_active)
  if (active.length < max) return { action: 'insert' }

  const evict = selectOldestSession(active, fingerprint)
  if (!evict) fail('تعذر تحديد الجلسة الأقدم')
  return { action: 'evict', evict }
}

export async function listSessions(supabase, userId) {
  const { data, error } = await supabase
    .from('user_sessions')
    .select(COLUMNS)
    .eq('user_id', userId)
  if (error) fail(error.message)
  return data || []
}

// Registers or refreshes this device. All mutation happens server-side in
// `engine_session_register`, which derives the user from auth.uid(), enforces
// the cap and performs eviction inside one transaction. The client cannot write
// user_sessions directly (INSERT/UPDATE/DELETE are revoked), so the cap cannot
// be bypassed by calling the REST API.
export async function registerDeviceSession(supabase, { fingerprint, deviceName }) {
  if (!fingerprint) fail('بصمة الجهاز غير صالحة')
  const { data, error } = await supabase.rpc('engine_session_register', {
    p_fingerprint: fingerprint,
    p_device_name: deviceName || null,
  })
  if (error) fail(error.message)
  if (!data?.ok) fail(data?.error || 'تعذر تسجيل الجهاز')
  return { action: data.action, session: data.session, evicted: data.evicted || null }
}

// Heartbeat for this device only.
export async function touchDeviceSession(supabase, { fingerprint }) {
  if (!fingerprint) return false
  const { data, error } = await supabase.rpc('engine_session_touch', { p_fingerprint: fingerprint })
  if (error) return false
  return Boolean(data)
}

// Normal logout: deactivates only this device's row.
export async function deactivateCurrentDevice(supabase, { fingerprint }) {
  if (!fingerprint) return false
  const { data, error } = await supabase.rpc('engine_session_signout', { p_fingerprint: fingerprint })
  if (error) fail(error.message)
  return Boolean(data)
}

// "Logout this device" from the settings list. The RPC filters by auth.uid(),
// so a crafted session id belonging to someone else is a no-op.
export async function deactivateSession(supabase, { sessionId }) {
  if (!sessionId) fail('جلسة غير صالحة')
  const { data, error } = await supabase.rpc('engine_session_revoke', { p_session_id: sessionId })
  if (error) fail(error.message)
  return Boolean(data)
}

// Newest activity first for display.
export function sortSessions(sessions) {
  return [...(sessions || [])].sort((a, b) => {
    const aTime = a.last_active ? new Date(a.last_active).getTime() : 0
    const bTime = b.last_active ? new Date(b.last_active).getTime() : 0
    return bTime - aTime
  })
}
