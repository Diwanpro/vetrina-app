# Phase 2: Engine

## Delivered workflows
- Dashboard chart: the current local calendar day plus the preceding six days,
  full Arabic weekday labels, zero-filled gaps, paginated Supabase reads scoped
  to the active store, refresh on focus/every minute, explicit loading/errors.
- Suppliers: scoped list, add modal, payment modal, remaining debt, links to purchases.
- Purchases: supplier and tenant-scoped variant selection (including UUID), multiple
  lines, totals, latest 20 receipts, stock receipt, supplier debt, weighted cost.
- Barcodes: optional base barcode in Add Product. A single variant retains that
  exact code; multiple variants receive distinct `-01`, `-02`, etc. suffixes because
  the existing database enforces global barcode uniqueness. Empty input generates
  independent CODE128-compatible codes. Existing variants without codes can be
  printed/scanned using their UUID, without mutating business data during printing.
- POS camera scanning via html5-qrcode, exact tenant-scoped lookup, store stock
  validation, automatic cart addition, quantity cap, manual-entry fallback, cleanup.
- Product print view: product name, size, color, locally generated CODE128 SVG,
  copy count and print CSS. The print button waits for label generation.

## Database and scope
`supabase/migrations/202611100002_engine.sql` was applied through the connector.
It adds missing supplier/tenant/store/request links and changes average cost to
numeric so recurring receipts don't repeatedly lose fractional cost.

New suppliers, supplier payments, purchases, and purchase items explicitly store
both tenant_id and store_id. Inventory's existing schema stores store_id and
variant_id; tenant ownership is inherited through the validated store/product.
Products and their variants remain a tenant-wide catalog: products carry tenant_id,
variants inherit it through product_id, and stock is separated by inventory.store_id.
No nonexistent tenant/store columns are sent to these existing tables.

RPCs validate the active staff profile (`users.auth_id = auth.uid()`), tenant,
store, and owner/manager role. Financial table reads have scoped RLS; direct client
financial writes are revoked, leaving only validated RPC writes. Supplier payments
and purchase receipts are single database transactions with row locks. Request IDs
make retries idempotent and reject reuse with different contents. Invalid lines,
foreign variants/suppliers, fractional/negative stock inputs, overpayments and
integer overflows fail without partial writes.

`cost_price_avg` belongs to a tenant-wide variant, so Old_Qty includes stock from
all stores of that tenant. The receiving store alone gets the quantity increase.
The database computes ((Old_Qty * Old_Cost) + (Qty * Unit_Cost)) / (Old_Qty + Qty).

Existing financial rows without scope are not assigned to a guessed store. Schema
inspection after migration found no existing suppliers, payments or purchases, so
there was no legacy data needing backfill. No login code was changed; app context
now distinguishes the auth ID from the staff ID for valid financial foreign keys.

## Verification performed
- `node --test tests/*.test.mjs`: 17 passing tests, including Arabic day boundaries,
  gaps and totals, purchase validation, averages and real JsBarcode CODE128 encoding.
- `npm run build`: passes using Next's test-only font response mock and placeholder
  public Supabase environment variables. Google Fonts is blocked by sandbox network
  policy. Neither the mock nor credentials are committed; production font settings
  remain unchanged.
- Supabase rollback-only tests: initial receipt, fractional second-receipt weighted
  cost, payment/debt update, receipt/payment idempotency, overpayment denial,
  foreign-tenant denial and rollback of invalid multi-line receipts.
- Additional rollback-only tests under the authenticated DB role: valid scoped
  supplier creation/read, direct financial-write denial, unauthenticated RPC/read
  denial. No test business records persisted.
- `tests/engine.integration.sql` combines these regression scenarios for a test
  database with an existing active owner/store fixture. It must always be rolled back.

## Device/browser acceptance still needed
1. Log in as owner/manager; create a supplier, then receive several variant lines.
   Compare purchase items, inventory and supplier debt; test a zero-cost line.
2. Pay part/all of the supplier balance; a larger-than-balance payment must fail.
3. Add a product with several color/size cells and a base barcode; print its labels.
   Verify each label identifies the exact variant and has a distinct code.
4. On a phone over HTTPS, allow camera access and scan a printed label. Exactly one
   unit of that variant should enter the cart. Repeat up to available stock;
   excess scans, unknown barcodes and other-tenant barcodes must be rejected.
5. Deny camera access and use manual entry. Close during camera startup and confirm
   the camera indicator turns off. After an unknown scan, manual entry must work.
6. Print preview should show only black/white labels, without app navigation.
7. Compare chart totals to the active store's sales for each local calendar date.

Camera hardware, printer output, and an authenticated browser walkthrough were
not available in this sandbox. Existing POS sale persistence is still its original
multi-request workflow; this phase makes purchase/payment persistence atomic,
not the pre-existing sale flow. Existing broader catalog/sales RLS is unchanged.
