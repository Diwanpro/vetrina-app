# Payroll and owner accounting

## Delivered
- Lifetime activation sets `is_active=true`, `is_activated=true`, `subscription_plan=lifetime`, and **subscription_end_date=NULL**. Owner-only; literal key matches after trimming.
- Owner-only `/dashboard/users`: tenant/branch employee list, username/PIN/role/store provisioning via the privileged Supabase Edge Function; manager/employee roles only. Login uses the existing `<username>@staff.vetrina.dz` convention. Desktop sidebar and mobile navigation both use the shared owner-only route gate.
- Advance/payroll RPC records the actual table-specific columns (`amount`, `amount_paid`, `reason`, `month`) and a store snapshot. Positive whole DZD only. Stable request UUIDs prevent repeated submission from paying twice. An open shift and sufficient recorded drawer cash are required. Row locking serializes payroll with shift closing; insert and cash deduction roll back together.
- `shifts.total_employee_payments` is separate from expenses to avoid counting wages twice. Expected drawer = opening cash + completed cash sales − employee payments. UI sends explicit actual−expected; closing RPC independently rechecks amounts under the shift lock and rejects stale values.
- Owner-only `/dashboard/accounting`: selected branch or All Branches; this month, this year, all time. Database aggregates avoid Supabase row limits and preserve existing RLS settings. Shows sales, expenses, salaries, advances, combined wages/advances, supplier payments, and requested net-profit formula.

## Accounting definitions / limits
- Requested net profit = completed sales − expenses − payroll − advances. Supplier payments are shown separately, not subtracted. This is **not** conventional profit after cost of goods, returns, tax or accruals.
- Expenses include all saved statuses. Wages use payment creation date, not the entitlement month. Advances are separate cash disbursements, not automatic offsets against later payroll.
- All periods use half-open local calendar boundaries converted to UTC. All Time ends at refresh time. Pending offline sales are excluded until synced. Sync POS receipts before wage payment or shift closing.
- New employee payments snapshot store. Old payments fall back to employee's current store because historical branch data cannot be reconstructed. Orphan wages cannot be safely attributed to a tenant and are excluded. Supplier payments fall back to the linked supplier's tenant/store for old records; unattributable records are excluded, never guessed. Repair legacy data before relying on totals for statutory reporting.
- Cash guard/reconciliation added here covers employee payments and completed cash sales. Other pre-existing cash flows (supplier payments, expenses, returns, collections) are not comprehensively integrated into the legacy drawer engine by this change.
- Auth + public profile provisioning is compensated across services, not transactionally atomic; see Edge Function README. No account creation browser E2E or actual-password login test was performed.
- Existing core RLS-disabled testing state remains unchanged. Frontend gates plus validated RPCs are not a substitute for production table policies/grant review. Requested shared lifetime key remains prototype licensing.

## Validation
- `npm test`: 37 tests pass, including owner route checks and period rollover tests.
- Production Next build passes using ignored Google Fonts mock and placeholder public Supabase values (sandbox blocks Google Fonts); production font config remains unchanged.
- Live admin BEGIN/ROLLBACK tests: activation clears expiry; scoped employee lists; advance/payroll inserts; idempotency; changed retry denial; no-open-shift denial; insufficient-cash rollback; cash deduction; stale and valid close; exact totals; branch isolation; manager denials; Auth/profile linkage and role-escalation rejection. No business/Auth test fixtures persisted.
- Reproducible SQL: `tests/payroll.integration.sql`, `tests/employee-registration.integration.sql`.
- Remote migrations applied: payroll_accounting, payroll_cash_guard, accounting_legacy_suppliers. Edge Function create-employee deployed ACTIVE with internal token verification.

## Manual acceptance before release
1. Owner activates an expired inactive tenant; verify active=true and expiry=NULL in DB.
2. Add manager and employee; sign in as each with chosen username/PIN; confirm branch locking and denied owner screens.
3. Open the employee branch drawer, record advance/payroll, retry after simulated response loss; verify single rows and single deduction.
4. Recount/close drawer while another owner records a payment; stale close must fail.
5. Compare month/year/all totals with known records across two branches, including legacy supplier payments.
