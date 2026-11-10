# Phase 1 verification

Run `node --test tests/cash.test.mjs` for cash totals, floor-price boundaries,
local-day bounds, pagination and query-error handling.

Authenticated manual acceptance (use a test store):
- Open a shift with a starting balance; reload and verify the green status.
- A second opening for the same store must fail (unique partial index).
- Record cash and non-cash sales; closing must include only cash sales since
  opening. This deliberately supports multiple shifts/day and overnight shifts.
- Count denominations; verify actual minus expected and mandatory nonblank notes
  for discrepancies. A sale arriving during counting requires review/reconfirmation.
- Close and reload; verify persisted status, amounts, notes and end time.
- In POS checkout, use “تعديل السعر / خصم”. Equal-to-floor is allowed;
  below-floor prices/discounts are rejected with the specified Arabic message.
- Verify audit_log contains old/new prices, variant, user, store and device.
  An audit insert failure must leave the cart price unchanged.
- Change a variant floor from another session before checkout; saving is blocked
  if the cart now violates it.
- Compare dashboard amounts and invoice count with today's store sales, and
  alert count with inventory quantities < 5. Counts must include >1000 rows.

Database migration was applied through the Supabase connector. Existing shift
rows remain closed. No authentication code or policies were changed.

Security boundary: these are client-side POS validations, not a replacement for
RLS/database price-enforcement policies. Existing multi-request sale/inventory
persistence remains unchanged and is not transactional. Shift closing and sales
are separate requests; fully atomic reconciliation requires a database RPC.

Build verification: the sandbox blocks Google Fonts. `npm run build` passes with
Next's test-only NEXT_FONT_GOOGLE_MOCKED_RESPONSES and placeholder public Supabase
environment variables. No test font mock or credentials are committed. Live
end-to-end transactions were not performed against production data.

## Shift schema fix and dynamic size types

Run `node --test tests/*.test.mjs` (10 tests). Supabase schema inspection
confirmed `shifts.difference` is a writable integer (`is_generated = NEVER`).
Both open/close writes now use the same explicit JS reconciliation helper.
No additional database schema changes are needed.

Product acceptance:
- Add Product > نوع المقاس: clothing has S/M/L/XL/XXL; shoes 39–45;
  pants 38/40/42/44/46/48.
- Enter stock, switch type, and verify all quantities clear, including shared
  numeric columns; custom colors stay. The form warns about this behavior.
- Enter stock for the active type, save, and inspect product_variants.size and
  corresponding inventory.quantity. Only positive whole-number stock is saved;
  inactive sizes never create variants.
- After a successful save the next product defaults to clothing with empty stock.

Production write tests were not performed: opening/closing a real shift or adding
products would change live business data. Payload calculations and size/quantity
selection are covered by automated tests; authenticated acceptance is still needed.
