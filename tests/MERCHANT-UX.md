# Merchant UX update

## Changes
- Purchases start with supplier selection and an Add Product/Series modal.
  The modal shows actual registered colors/sizes, a shared unit cost, quantities,
  piece count and subtotal. Missing variant combinations are unavailable rather
  than inventing inventory records. Products can be edited/replaced or removed;
  editing never silently adds the same quantities twice. UUIDs are internal only.
- Invoice-level وصف المنتج supports multiline typing and Arabic dictation.
  It is persisted on purchases and displayed in invoice history.
- components/VoiceInput.js uses webkitSpeechRecognition (or SpeechRecognition),
  explicit start/stop, ar-DZ, separate interim feedback, deduplicated final results,
  append-to-latest-value semantics, field-length limits, manual fallback and errors.
  Saving/navigation/unmount releases the recognition session.
- Add Product reserves a globally distinct 12-digit numeric code on first open.
  Regenerate reserves another code. Camera scanning can replace it with an existing
  external barcode, including other lengths. The visible code is kept for the first
  variant; additional variants receive independent reserved 12-digit codes. This
  supersedes the older Phase 2 suffix-based barcode behavior.
- Supplier goods remain a multiline textarea, now with five rows, resize support
  and a two-line merchant example; list rendering preserves line breaks.

## Database
Migration 202611100003_merchant_ux.sql was applied through Supabase.
- Adds purchases.description.
- Adds an authenticated, store/tenant-validated numeric barcode reservation RPC.
  Its private noncycling sequence produces 100000000000 through 999999999999 and
  skips existing manually assigned codes. The existing UNIQUE(barcode) constraint
  is still the final concurrent-write guard. Canceled forms and tests consume
  sequence numbers by design; gaps are harmless and numbers are not reused.
- Adds engine_receive_purchase_with_description as an atomic wrapper of the
  existing receipt RPC. Description, purchase/items, stock, weighted average and
  debt succeed/fail together. Retry validation includes the description. The old
  RPC is preserved for existing clients.
- Scanned barcode collisions are checked before creating the product. Existing
  product-creation persistence remains its pre-existing multi-request flow.

## Verification
- npm test: 23 tests pass. New tests cover real-size matrix axes, quantity/cost
  validation, zero/empty cells, replacing a series, 200-line limit, speech interim
  vs final results, duplicate-final suppression and append/length behavior.
- Production build passes with a test-only Next font mock and placeholder public
  Supabase env values because the sandbox blocks Google Fonts. No mock/secrets are
  committed and production font configuration is unchanged.
- Supabase rollback-only checks passed: six distinct 12-digit reserved codes,
  multiline supplier-goods preservation, multiline invoice-description persistence,
  identical-retry idempotency without doubled stock, rejection of changed-description
  retries, and overlong-description rejection without creating a receipt.
  No business test records remain; barcode sequence reservations persist by design.

## Browser/device acceptance
1. Select a supplier, add a shoe or pants product, enter several colors/sizes and
   a unit cost, confirm and verify quantities/totals. Edit the series and confirm
   quantities are replaced, not added again. Add another product; delete one.
2. Save a multiline description and reload history. Compare stock/debt/average
   values with the original Phase 2 receipt behavior.
3. In Chrome/another supported browser over HTTPS, allow microphone access,
   dictate Arabic, stop, type corrections, start another session, and save.
   Final speech should append once and interim speech should not overwrite text.
4. Deny microphone permission or use an unsupported browser: the message should
   explain the issue and typing must remain available. Close/navigate during
   recognition and confirm the microphone indicator stops.
5. Open Add Product: default barcode must be 12 digits. Regenerate it, scan a
   camera label, verify exact field fill, then save/print/scan the matching variant.
   Check that other color/size variants have independent numeric codes.
6. Enter supplier goods over several lines and verify newlines after saving.

Physical microphone/camera/printer use and an authenticated browser walkthrough
were not available here; their device-level behavior still needs acceptance.
