# Phase 3 implementation and code review

## Scope and permissions
- A shared dashboard layout resolves the authenticated staff profile before
  rendering pages or running their effects. No employee/manager falls back to
  the first store when unassigned: the UI stops with an actionable error.
- Owners have a real tenant-scoped branch selector and All Branches. There is
  no branch count limit. Store creation is owner-only in Settings.
- All-branch dashboard/chart queries filter a stores tenant join, not a huge
  `IN (...)` URL. A 5,000-branch scope is covered in tests. Financial reads and
  mutations require a concrete branch; the UI explicitly asks owners to choose one.
- Managers/employees never receive another branch in their context and never
  see a branch selector. Selection tampering in localStorage is ignored.
- Sales, credits, inventory, nested product/variant stock, barcode reads,
  purchase selection, details and exports carry explicit store/tenant filters.
  Tenant-wide catalog tables inherit branch scope through inventory joins.
- Employee routes: dashboard, POS, sales, credits, inventory and personal sync
  Settings. Managers additionally manage products, suppliers and purchases.
  Transfers, new branches and activation are owner-only. UI navigation AND direct
  route rendering enforce these restrictions.
- Financial read RPCs preserve the existing financial RLS while allowing an owner
  with a home-store assignment to manage a different store in the same tenant.
- Account, staff role or assigned-branch changes remount the page to discard old
  in-memory results. A branch switch warns about unsaved drafts and reloads the
  page; outbox records always retain their original branch and author.

## Transfers
- Owner-only page with source/destination, real product/color/size labels and stock.
- One server transaction validates same-tenant ownership, locks stock, checks
  availability, records transfers/transfer_items, subtracts source and adds target.
- Request IDs make a retry safe without moving stock twice. No cost change is
  needed because the tenant-wide variant's total stock/cost does not change.
- Local unsynced sales for either branch on this device must sync first.

## Offline-first POS and PWA
1. Log in online and open POS for each branch you intend to use offline.
2. Wait for its catalog to finish loading. The production service worker warms
   the visited HTML shell and Next static assets. Installable PNG icons, manifest,
   offline fallback and service worker are included.
3. Offline, only a previously verified cached profile and that account/branch's
   catalog may be used. First-time login, activation, new branches, purchases and
   stock transfers require a connection.
4. Every checkout, online or offline, first commits the receipt AND cached-stock
   reservation in one IndexedDB transaction. A failed write leaves the cart intact.
   Concurrent reservations against the same cached catalog cannot overspend it.
5. After local durability the cart clears and clearly reports pending vs synced.
   The app syncs on entry/reconnection and every 30 seconds while open; Settings
   and TopBar offer manual retry. It does not promise sync while the browser is shut.
6. Server sync uses a unique (store_id, local_id), calculates its own totals,
   validates tenant/author/store, price floors and stock, and transactionally writes
   the invoice, lines, stock decrement and synced_at. Lost acknowledgments are safe.
7. Staff identity is pinned in the RPC, so another account signing in mid-sync
   cannot become the author of old receipts. Queues are never silently reassigned.
8. Stock/floor conflicts remain in IndexedDB with their error. They are not dropped.
   Settings shows retry errors and allows JSON backup; sales history includes local
   receipts and avoids duplicating pending rows already present on the server.
9. Price edits first persist an audit entry locally, which is also synced idempotently.
10. Do not clear browser/site data until all receipts have synced. IndexedDB is
    local device storage, not a cloud backup; quotas/eviction/device loss still apply.

The service worker caches same-origin shells and static assets only, never auth,
Supabase/API responses or mutations. The account-scoped IndexedDB is deliberately
not a service-worker cache. Browser caches are not a substitute for authorization.
Cached revocation/assignment changes cannot be learned while fully offline; the
server rechecks access when syncing. Sales across multiple disconnected devices
can conflict; conflicts must be resolved rather than inventing stock or losing sales.

## Trial, activation and exports
- Login resolves the tenant; the layout locks when `is_active === false` AND
  `subscription_end_date` is in the past, exactly as requested. The condition is
  also checked for new branch/finance/sale/transfer RPC operations.
- Lock screen keeps existing data and gives owners the activation form. Exact
  `VETRINA-LIFETIME` activates only the current owner's tenant, through an RPC.
- This shared static key is a requested prototype activation mechanism, NOT a
  production-grade license/entitlement system. Replace it with issued per-tenant
  keys or a licensing service before commercial public launch.
- Owner/manager Settings exports paginated branch-scoped sales and product/variant
  stock CSV (UTF-8 BOM, quotes/newlines escaped, spreadsheet-formula neutralization).
  Owners may select All Branches. Pending local operations have a separate backup
  so they are not misrepresented as successfully synced server sales.

## Database/RLS review — IMPORTANT
- Applied `202611100004_phase3.sql` through the Supabase connector (base migration,
  identity-pinning follow-up and branch-financial-read follow-up).
- No RLS flag, policy or table mutation grant was changed. Contrary to the general
  assumption that all RLS was disabled, inspection found a mixed setup: disabled on
  credits/customers/inventory/product_variants/products/sale_items/sales/shifts;
  enabled on the remaining 19 existing public tables. These settings remain intact.
- New RPCs check current_staff(), allowed roles, tenant, branch and subscription,
  and use fixed search paths. Atomic stock operations use row locks; author and
  request IDs are validated. Existing financial operations reuse the stronger
  branch validator without losing owner multi-branch support.
- Frontend filtering is NOT security against direct calls while core RLS is disabled.
  Existing unrestricted database APIs remain a production blocker. Strict tested
  RLS, privilege review and server-side enforcement for all legacy writes are still
  required before opening this SaaS to untrusted tenants.

## Review fixes and remaining limitations
Fixed: fake TopBar branches/date; first-store fallback for nonowners; unscoped sale
and credit reads/details; missing nested catalog stock filters; employee access to
financial/product pages; weak auth-vs-staff mapping; nontransactional POS writes;
uncaught sales/credit loading errors; swallowed customer lookup errors; stalled
request paths (20-second fetch bounds); misleading zero net-balance KPI; inability
to remove/decrement a cart line; CSV injection; lost sale author on session changes;
and stale page results on assignment/account changes.

Reviewed login, root redirects, app context, layouts/navigation, dashboard/chart,
POS/discount/audit, products/labels, credits, purchases/suppliers, shifts, inventory,
settings, transfers, static PWA assets, Supabase client and all migrations.

Remaining explicitly outside this delivery:
- Device-level microphone, camera, printer, installability and offline navigation
  acceptance still need a real browser/device check. Unit/DB tests don't prove them.
- Products (including image storage) and customer/credit creation keep their legacy
  multi-request persistence. Failures can require manual cleanup; they are online
  only. They are not included in the offline sales outbox.
- Existing split cash/credit input fields in POS are not a credit-accounting engine;
  the supported invoice payment methods remain cash/check/CCP, as before.
- Profit uses the current weighted-average cost, not a historical cost snapshot.
  Net-balance reporting is shown unavailable instead of claiming a real zero.
- Branches with legacy transfers lacking tenant_id are not backfilled by guessing.
- The app remains testing-grade for authorization until strict production RLS is
  completed. Offline data on shared/unlocked devices also needs physical security.

## Verification and acceptance
- `npm test`: 35 passing tests, including IndexedDB transactions via fake-indexeddb,
  rollback on invalid sale, concurrent reservations, account/tenant/branch isolation,
  queue conflict retention/acknowledgments, 5,000 branches, permission routes, trial
  boundaries, pagination, matrix/voice helpers and safe CSV.
- `npm run build`: verified with a test-only font response mock and placeholder
  public Supabase env values because Google Fonts is blocked in the sandbox. No
  credentials or test mock is committed; production font settings are unchanged.
- Rollback-only Supabase tests passed: branch creation/listing; atomic transfer and
  idempotent retry; sale sync and no double stock decrement; wrong-author/low-floor
  rejection and rollback; manager branch isolation and transfer denial; employee
  activation denial; expired-account rejection; invalid and valid activation;
  owner home-store cross-branch financial read and manager denial. No business
  test fixtures or account/subscription changes persisted.

Before release: test owner All Branches totals against two stores; test direct
employee/manager URLs and manipulated branch selection; create two branches and
transfer stock; open POS online, disconnect, sell, reload, reconnect, and verify
one server invoice + stock decrement despite retries. Repeat with account changes,
server stock/floor conflicts, IndexedDB disabled/full, expired trials, activation,
and CSV files in an Arabic-capable spreadsheet. Confirm no RLS flags changed.
