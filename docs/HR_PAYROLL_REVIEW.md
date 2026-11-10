# HR / payslip / attendance pass

## Schema and deployment
The user authorized the missing `users.commission_percentage` column after read-only inspection confirmed it was absent. Migration `202611100012_hr_payroll.sql` adds numeric(5,2), default 0, non-null, checked 0–100. Existing salary_type already supports fixed, commission, fixed_commission and daily. Existing attendance has UNIQUE(user_id, attendance_date). No RLS flag/policy changes.

Updated HR creation RPC supports all four types and commission percentage, validates bounds/two-decimal precision, and normalizes hidden fields: commission-only has salary_amount=0; fixed/daily have commission_percentage=0. Default percentage preserves old fixed/daily RPC clients without a PostgREST overload. Existing RPC owner/store/Auth-metadata checks remain. Deployed create-employee Edge Function version 3 performs matching validation and sends the new parameter; service credentials remain server-only.

## UI
- Exactly four choices: أساسي / عمولة / أساسي + عمولة / يومي. Fixed amount, percentage, both, or daily rate are conditionally shown. Changing type resets draft salary fields; hidden values are normalized again on submission and server-side.
- HR rows show rate/amount and present-day count for current month. New owner-only engine_hr_overview returns tenant-scoped profile fields and database attendance counts, avoiding response-limit truncation/N+1 attendance fetches.
- Payslip modal: named employee/tenant/month, base salary, completed synchronized employee sales, percentage and commission, advances and net payable, with signature lines and a review label. It is read-only, does not record payroll and does not imply prior payroll has not been paid. Failures display errors/retry, not misleading zero totals.
- Settings always shows an owner Activation Key input and Upgrade Branches input below, with a green الحساب نشط badge when active. Existing licensing rules are unchanged: a new VTR key on an already-active account may be rejected; UPG is the supported additive upgrade mechanism. Both inputs remain visible regardless of activation state.

## Calculation definitions
The current month/day uses Africa/Algiers consistently server-side, independent of browser timezone. Half-open month bounds prevent previous/next month leakage. Sales are completed invoices for that employee across all branches in the same tenant, regardless of the currently selected HR branch. Pending offline receipts are excluded until synchronized.

Commission = round(total sales × percentage / 100, 2). Net payable = stored salary_amount + commission − current-month advances. Negative balances are retained rather than clamped. This is the explicitly requested formula, not a full payroll settlement engine: previously recorded payroll, taxes and other deductions are not subtracted. **Daily staff see the stored daily rate as the base; it is not multiplied by attendance days**, with an explicit UI note. A daily-earned-pay formula would need separate approval.

Existing legacy commission profiles retain their old salary_amount and get percentage=0; no inferred historical percentage or destructive amount backfill is performed. Review legacy salary contracts before using these figures for payment.

## Attendance
- On verified dashboard session entry after login, nonowner attendance RPC records today's present row. Periodic verified session refresh retries. It pins staff identity, validates assigned store/subscription and never overwrites an existing day/status.
- A sales INSERT trigger records the employee's sale date. This covers existing online/sync sale paths without risking outbox acknowledgments or clearing carts differently. Backdated offline sales create attendance for their original checkout date when synced. UNIQUE + ON CONFLICT DO NOTHING handles login/sale/concurrent retry duplicates.
- Owners are not auto-clocked; managers and employees are. Attendance errors show an Arabic warning and do not block login or sale checkout. A fully offline restored session cannot persist attendance until reconnect; an offline sale gets its original day upon sync.
- No historical attendance backfill is performed. An existing absence/other status is deliberately not replaced because the requirement is insert only when the day has no record.

## Verification
- 44 Node tests pass, including four-type conditional mapping, hidden-field normalization, decimal percentage bounds, existing cash/POS/IDB/scoping tests.
- Production Next build passes using ignored Google Fonts mock and placeholder public environment values due sandbox networking restrictions. Production font config unchanged.
- Live admin rollback checks pass: all four Auth-linked HR types, zeroed hidden fields, invalid percentages, two login attendance calls plus sale create one row/day, historical sale attendance, monthly count, exact payslip sales/commission/advances/net (30000 / 1500 / 5000 / 26500), previous-month exclusion, employee payslip denial and wrong-staff attendance denial. Test fixtures/account changes all rolled back. Reproducible script: tests/hr-payroll.integration.sql.
- Browser PIN login, dynamic form visual acceptance, concurrent real devices and mobile payslip layout remain manual acceptance tasks. Existing production RLS/licensing blockers in COMMERCIAL_REVIEW.md are unchanged.
