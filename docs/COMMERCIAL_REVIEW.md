# Commercial feature pass — 2026-11-10

This document supersedes older unlimited-branch/lifetime-key and HR/payroll page descriptions.

## Delivered
- Settings switches between `VTR-X-suffix` activation (inactive accounts) and `UPG-X-suffix` additive branch upgrades (active accounts). Positive integer X, bounded integer arithmetic, nonempty alphanumeric/hyphen suffix, maximum key length 200. VTR clears expiry and sets branch cap; VTR cannot shrink below existing stores or reactivate an already active account. The old `VETRINA-LIFETIME` key is replaced by this contract.
- Tenant row locks serialize activation/upgrades/branch creation; repeated exact keys are no-ops via private per-tenant redemption hashes. Frontend blocks branch creation at cap with an alert; server independently recounts under lock. Existing branches above the new default cap are retained, but no further branches can be added without an upgrade. Existing entitlement values are not silently rewritten.
- `/dashboard/users` is HR only: owner-only modal creates Auth account and a public profile with first/last name, full name, salary type (`fixed`, `commission`, `daily`), integer salary amount, username, role, store. Commission amount is DZD, not a percentage. Lists include legacy placeholders rather than invented HR data. Payout actions moved to Accounting; previous open-shift, cash guard and retry protections remain.
- The updated `create-employee` Edge Function verifies bearer token and owner/store/HR input server-side; calls the new HR RPC. Old bare registration is no longer callable by authenticated users. Admin-only credential never reaches the browser. Auth/profile creation still uses compensation across services rather than one atomic transaction.
- All staff can record expenses from the top bar (assigned branch only for nonowners), without access to the owner accounting screen. Positive whole DZD, required description, optional private receipt. Online-only. RPC checks current staff, subscription, scope and original author, and uses retry UUIDs. Existing expense entry base RPC is not directly callable by authenticated clients.
- Receipts: private `expense-receipts` bucket, 5MB JPEG/PNG/WebP/PDF; tenant/store/uploader folders, no overwrite, no public URL. Owner can read tenant receipts; other staff can read only their own currently assigned-branch receipts. Short-lived signed URLs only. New bucket-specific insert/select/delete policies do not alter existing app-table policies or RLS flags. Attached receipts cannot be deleted through the cleanup policy, including when old expense RLS hides them from the caller.
- Accounting layout: exactly four KPI cards, native accessible SVG donut with textual legend (no heavy chart dependency), then paginated journal (50/page, deterministic order and hasMore). Shared branch selector supports All Branches. Date filters retained. Zero datasets and losses have explicit states; negative profit is not rendered as a misleading positive sector. Receipt links use private signed URLs.
- Owner-only Users/Accounting icons were already present and remain filtered in desktop/mobile nav; direct routes remain denied for other roles. Dark/Gold surfaces, responsive tables, disabled submission states and Arabic labels retained.

## Financial definitions
Commercial screen net profit = completed sales − COGS − expenses − payroll − advances. This intentionally differs from the previous requested simplified formula; the screen labels it explicitly. Supplier payments are not subtracted again. Base accounting RPC remains available for compatibility.

New sale items capture variant average cost at insertion/sync using a server trigger. Changing inventory average later does not alter captured cost. Legacy items without snapshots use current cost as an **estimate**, with estimated-item count shown. Offline invoices synchronized later capture cost at sync, not necessarily at the historical offline checkout instant. No historic cost backfill is invented. This report still does not provide tax/returns/accrual accounting or automatically offset advances against salaries.

Expenses include saved statuses, and payroll is attributed by payment creation date. New expenses are recorded approved immediately (no separate approval workflow was requested). Expense recording affects accounting totals, **not** the existing cash-drawer expectation: unlike payroll cash payments, expense payment method/drawer settlement has not been specified. This distinction is displayed in the expense modal. Sync local sales before financial review.

Journal has sales, expenses, payroll and advances; it is an activity journal, not a double-entry ledger. Legacy unattributable wage/supplier rows follow the safe attribution rules documented in PAYROLL_ACCOUNTING.md. Pagination is stable for a fixed dataset, not a transactional snapshot across concurrent edits.

## Review findings / release blockers
1. **Prefix-only keys are not commercially secure entitlements.** The requested format accepts syntactically valid keys, not issuer-verified keys. Exact-key replay is prevented per tenant, but different suffixes or reuse by another tenant remain possible. Add a signed-key verification scheme or controlled issued-key registry before paid licensing. No fabricated issuer validation is claimed.
2. **Existing core RLS-disabled test configuration is preserved.** Frontend guards and the validated new RPCs do not secure direct queries to old tables. A production RLS/grant audit remains mandatory. New license_redemptions has all public/anon/authenticated table access revoked.
3. Auth creation and profile insertion span services. Compensation failure logs an Auth ID for admin cleanup, not credentials. Browser-level account creation, actual PIN login, mobile receipt upload, signed-URL preview and visual device acceptance remain manual.
4. Expense/receipt retry UUIDs survive retries while the mounted form is retained, not a browser reload. After an ambiguous timeout, retry unchanged data before closing/reloading. Changing a draft after an upload may leave an unreferenced private object; an admin can reconcile these. The UI does not blindly delete uploads on ambiguous database errors because the expense may have committed.
5. Existing product, supplier, cash and offline feature limitations in previous review documents still apply. This change is not certification of production launch readiness.

## Applied and tested
- Connected database already had branches_limit and the four HR columns; their schema/constraints were inspected, not guessed.
- Migrations applied: commercial_licensing_hr_accounting, receipt_cleanup_guard, expense_author_pin, cost_tenant_guard. Matching local SQL 008–011. Edge Function create-employee updated ACTIVE version 2.
- 41 Node tests pass: existing POS/IDB/size/cash tests plus license boundary checks, HR validation, safe receipt constraints, empty/loss chart data. Production Next build passes using ignored font mock and placeholder public env because Google Fonts is network-blocked here; production Tajawal config unchanged.
- `tests/commercial.integration.sql` was executed as an admin BEGIN/ROLLBACK transaction: activation expiry clearing/cap, session metadata, capped branch denial, additive upgrade retry, Auth-linked HR validation, future-cost capture unaffected by later cost change, exact COGS/net totals, branch isolation, expense retry/changed payload denial, journal types and 50+9 pagination without duplicates, receipt scope/attached cleanup guard, employee expense allowed but cross-branch/journal/accounting/upgrade denied. No business/Auth/storage fixtures persisted.
- Authenticated-role expense wrapper and wrong-author denial also passed; bare registration/expense RPC execute grants were verified revoked. A direct SQL storage-deletion probe was rejected by Supabase's built-in storage protection; no bypass was attempted, and deletion via the Storage API remains a manual acceptance item. Failed probe fixtures were confirmed rolled back.
- Original SQL rollback suites updated for current key/cap/HR contract; these files remain admin-only.

## Manual acceptance checklist
- Inactive owner activates VTR, reaches branch cap, upgrades UPG; retry the same upgrade after simulated response loss.
- Concurrent branch creates cannot exceed remaining capacity.
- Create fixed/commission/daily staff via HR; sign in as each with PIN and verify assigned branch and owner route denial.
- Employee records with/without a receipt; owner sees journal and can open signed receipt; another tenant cannot read it. Retry after upload/DB response loss.
- Test 360px/mobile and desktop layouts, four KPIs, empty chart, loss chart, long journal descriptions and receipts.
- Compare period totals with known transactions and perform production RLS/licensing hardening before paid launch.
