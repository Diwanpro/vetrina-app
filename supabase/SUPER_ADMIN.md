# Super Admin licensing

Hidden issuer panel at **`/super-admin`** plus database-verified activation keys.
Attia Web Solution generates keys there; tenants redeem them in `/dashboard/settings`.

## How the password is handled

The panel password is **never** stored in Git, in the bundle, or in the browser.

- The database holds **only a bcrypt hash** (cost 12) in `public.app_settings`,
  key `super_admin_password_hash`.
- `public.app_settings` has RLS enabled with **no policies** and every
  `anon`/`authenticated` privilege revoked, so the hash cannot be read through
  PostgREST even with a valid JWT.
- The hash is read only by `super_secret_hash()` (SECURITY DEFINER), which is
  itself revoked from `PUBLIC`, `anon` and `authenticated`.
- The browser sends the typed password on each RPC call. It is kept in
  `sessionStorage` only so a page refresh does not force a re-login, and it is
  re-verified by the database every single time — never trusted locally.

`ALTER DATABASE ... SET app.secret_hash` was attempted first but Supabase's API
role is not superuser (`permission denied to set parameter`), which is why the
hash lives in a locked table instead.

## Rotating the password

Run as an admin (psql / SQL editor). Nothing else needs to change.

```sql
UPDATE public.app_settings
   SET value = extensions.crypt('NEW-PASSWORD-HERE', extensions.gen_salt('bf', 12)),
       updated_at = now()
 WHERE key = 'super_admin_password_hash';
```

Everyone signed in to the panel is invalidated on their next database call.

## Brute-force protection

`super_admin_attempts` records failures per source IP (`x-forwarded-for`, falling
back to `local`). After **8 failures in 15 minutes** the panel answers
"محاولات فاشلة كثيرة" until the window passes. Rows older than a day are pruned
on each attempt. The client IP is only available when the request reaches
Postgres through the Supabase gateway; direct SQL callers share the `local`
bucket.

## Key format

```
VTR-{branches}-{6 chars}     activation
UPG-{branches}-{6 chars}     upgrade
```

- 6 characters from a 32-symbol alphabet: `ABCDEFGHJKLMNPQRSTUVWXYZ23456789`.
  `I`, `O`, `0` and `1` are excluded so keys survive being read aloud or typed
  by hand.
- Generated with `extensions.gen_random_bytes`; 32 divides 256 exactly, so
  `byte % 32` introduces **no modulo bias**.
- `license_key` is `UNIQUE`; a collision is retried up to 12 times.
- 32^6 ≈ 1.07 billion bodies, and the key is only valid if the exact row exists.

## Redemption (`public.engine_activate`)

The previous implementation accepted any string matching the regex — a forged
key like `VTR-9-ZZZZZZ` would activate a tenant. It now:

1. Requires an authenticated **owner** of the tenant.
2. Locks the tenant row, then looks up the **exact** key in `public.licenses`
   with `FOR UPDATE` (two tenants cannot race for one key).
3. Rejects a key that is missing, already `is_used`, or already has
   `used_by_tenant_id`.
4. **Activation** → `is_active = true`, `is_activated = true`,
   `subscription_end_date = null`, `branches_limit = licenses.branches`,
   `subscription_plan = 'lifetime'`. Refuses if the account is already active
   (that is what upgrade keys are for) or if the branch count is below the
   tenant's existing stores.
5. **Upgrade** → `branches_limit += licenses.branches`, with overflow guard.
   Refuses when the account is not active yet.
6. Marks the row `is_used = true`, `used_by_tenant_id = <tenant>`, and records
   `license_redemptions(tenant_id, md5(key))` as an audit trail.

The returned message distinguishes *not found* from *already used* so the owner
knows whether to re-check the code or ask for a new key.

## RPCs

| Function | Grantee | Purpose |
| --- | --- | --- |
| `engine_admin_generate_license(p_password, p_type, p_branches)` | `anon`, `authenticated` | Issue a key, return it as JSON |
| `engine_admin_list_licenses(p_password, p_limit)` | `anon`, `authenticated` | Recent keys for the panel |
| `engine_activate(p_key)` | `authenticated` | Redeem a key for the caller's tenant |
| `super_admin_guard(p_password)` | none (internal) | Password + rate-limit check |
| `super_secret_hash()` | none (internal) | Read the bcrypt hash |

The two issuer RPCs are granted to `anon` because the panel is gated by its own
password rather than by a Supabase session. **Minting requires a correct
password; that is the only thing standing between an anonymous caller and a new
key.** If that is not acceptable, move the panel behind Supabase Auth and drop
the `anon` grant.

`super_admin_guard` is intentionally not executable by clients: exposing it
would turn the database into a password oracle.

## Migrations

- `202611100013_license_keys.sql` — attempt log, guard, issuer RPCs, new
  `engine_activate`, grants.
- `202611100014_super_admin_secret.sql` — `app_settings`, `super_secret_hash()`,
  initial hash.

## Verified on the live database (2026-11-10)

Executed inside `BEGIN … ROLLBACK`, so no fixture persisted:

- correct password issues `VTR-3-XXXXXX` / `UPG-2-XXXXXX`, rows land unused;
- `engine_admin_list_licenses` returns them;
- forged `VTR-9-ZZZZZZ` is rejected;
- activation sets `branches_limit = 3`, clears the expiry, marks the key used;
- reusing that key is rejected;
- upgrade adds 2 to the limit (3 → 5) and marks the second key used;
- reusing the upgrade is rejected;
- wrong password is rejected; the 7th failure in a row is throttled;
- `app_settings`, `licenses`, `super_admin_attempts`: RLS on, 0 policies, no
  `anon`/`authenticated` grants.

Not covered automatically: the panel UI itself in a browser (password entry,
copy button, table rendering) — that remains a manual check.

## Known limitations

- The redirect from the Settings page after activation is `location.reload()`;
  the page still shows the old status until the session refetches.
- Keys are single-use and bound to the first tenant that redeems them. There is
  no "revoke" or "reassign" action in the panel yet; do it in SQL.
- The panel is discoverable by URL. Nothing links to it, but it is not
  IP-restricted, so treat the password as the only control.
