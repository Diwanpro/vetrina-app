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

// Pure decision function for the register flow. Returns the action to take so
// the behaviour is testable without a database.
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

// Registers or refreshes this device. Must run with an authenticated session so
// `user_id = auth.uid()` is allowed by RLS.
export async function registerDeviceSession(supabase, { userId, fingerprint, deviceName }) {
  if (!userId) fail('لا توجد جلسة مستخدم')
  if (!fingerprint) fail('بصمة الجهاز غير صالحة')

  const rows = await listSessions(supabase, userId)
  const plan = planSession(rows, fingerprint)

  if (plan.action === 'touch') {
    const { error } = await supabase.from('user_sessions')
      .update({ last_active: new Date().toISOString() })
      .eq('id', plan.session.id).eq('user_id', userId)
    if (error) fail(error.message)
    return { action: 'touch', session: plan.session }
  }

  if (plan.action === 'revive') {
    const { error } = await supabase.from('user_sessions')
      .update({ is_active: true, last_active: new Date().toISOString() })
      .eq('id', plan.session.id).eq('user_id', userId)
    if (error) fail(error.message)
    return { action: 'revive', session: plan.session }
  }

  let evicted = null
  if (plan.action === 'evict') {
    const { error } = await supabase.from('user_sessions')
      .update({ is_active: false })
      .eq('id', plan.evict.id).eq('user_id', userId)
    if (error) fail(error.message)
    evicted = plan.evict
  }

  const { data, error } = await supabase.from('user_sessions')
    .upsert({
      user_id: userId,
      device_fingerprint: fingerprint,
      device_name: deviceName || null,
      last_active: new Date().toISOString(),
      is_active: true,
    }, { onConflict: 'user_id,device_fingerprint' })
    .select(COLUMNS)
    .single()
  if (error) fail(error.message)
  return { action: plan.action === 'evict' ? 'evict' : 'insert', session: data, evicted }
}

// Normal logout: only this device's row is deactivated.
export async function deactivateCurrentDevice(supabase, { userId, fingerprint }) {
  if (!userId || !fingerprint) return
  const { error } = await supabase.from('user_sessions')
    .update({ is_active: false })
    .eq('user_id', userId).eq('device_fingerprint', fingerprint)
  if (error) fail(error.message)
}

// "Logout this device" from the settings list. Scoped by user_id so a crafted
// session id cannot deactivate someone else's device.
export async function deactivateSession(supabase, { userId, sessionId }) {
  if (!userId || !sessionId) fail('جلسة غير صالحة')
  const { error } = await supabase.from('user_sessions')
    .update({ is_active: false })
    .eq('id', sessionId).eq('user_id', userId)
  if (error) fail(error.message)
}

// Newest activity first for display.
export function sortSessions(sessions) {
  return [...(sessions || [])].sort((a, b) => {
    const aTime = a.last_active ? new Date(a.last_active).getTime() : 0
    const bTime = b.last_active ? new Date(b.last_active).getTime() : 0
    return bTime - aTime
  })
}
