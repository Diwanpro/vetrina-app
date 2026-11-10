-- Row-level security for public.user_sessions.
--
-- The table already had RLS enabled with ZERO policies, which means every
-- request from anon/authenticated matched no policy and returned no rows —
-- inserts would have silently affected nothing and the settings screen would
-- always look empty. These policies scope the table to the signed-in user.
--
-- Threat model note: `user_id = auth.uid()` lets any signed-in user select,
-- insert and update rows for their own auth id. That is what self-service
-- device management requires. It also means a user could clear their own
-- `is_active` flags, i.e. exceed the two-device cap for their own account.
-- The cap is a fair-use/product limit, not a security boundary; enforcing it
-- against a hostile account would require a server-side RPC.

CREATE POLICY user_sessions_select ON public.user_sessions
  FOR SELECT TO authenticated
  USING (user_id = auth.uid());

CREATE POLICY user_sessions_insert ON public.user_sessions
  FOR INSERT TO authenticated
  WITH CHECK (user_id = auth.uid());

CREATE POLICY user_sessions_update ON public.user_sessions
  FOR UPDATE TO authenticated
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

-- No DELETE policy: rows are kept and flagged inactive so the
-- UNIQUE(user_id, device_fingerprint) row can be revived on the next login.

-- Helpful for the "oldest active session" lookup.
CREATE INDEX IF NOT EXISTS user_sessions_active_lookup
  ON public.user_sessions(user_id, is_active, last_active);
