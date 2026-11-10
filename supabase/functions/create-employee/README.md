# Employee provisioning

Deployed function: `create-employee` (POST).

The function reads Supabase's built-in URL, anon key and service-role key in the Edge runtime. No service-role key belongs in NEXT_PUBLIC variables or browser code. It validates the bearer token through `auth.getUser`, reloads owner/tenant/store context, and then creates a confirmed Auth account. PIN is the Auth password (6–12 digits); no plaintext PIN or duplicate hash is saved to public.users.

Deployment: `supabase functions deploy create-employee --no-verify-jwt --project-ref <project-ref>`.
Gateway JWT verification is disabled intentionally to support current Supabase key types; **the function itself always verifies the access token** before privileged operations. Never remove that verification.

`engine_register_employee` independently validates owner access, store, role, username and server-only `app_metadata.created_by_owner`. If profile creation fails, the function attempts to remove the newly-created Auth user. Auth creation and SQL registration span two services, not one transaction: inspect Edge logs if compensation fails; log messages include only the orphan Auth ID, never PIN/token. Duplicate login names are rejected by Auth. After a timeout, refresh employees before retrying. No existing account is adopted, reset, or overwritten.
