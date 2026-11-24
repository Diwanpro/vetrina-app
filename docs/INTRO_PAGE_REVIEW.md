# Vetrina introduction page review

## Scope
- Add `public/intro.html`, served at `/intro.html` using the repository's existing public HTML convention.
- Add `tests/intro.test.mjs` (four automated checks).
- No existing route, application logic, configuration, database, deck, or guide changed.
- Attachment received: `index (4) (1).html`, not the ZIP mentioned in the request. Its referenced `vetrina-logo.webp` was not attached. Reuse existing `public/assets/deck/logo.png`; only the image URL differs from supplied HTML. No new logo binary needed.
- Both action links retain the exact production URLs requested, opening secure new tabs.

## Validation
- `node --test tests/intro.test.mjs`: 4 passed, 0 failed. Checks Arabic/RTL, viewport, exact links, safe tabs, accessible logo, PNG signature, mobile single-column CSS, reduced-motion CSS, and no scripts/forms/iframes.
- `npm test`: 722 tests, 718 passed, 3 failed, 1 skipped. Existing failures: presentation-link.test.mjs dashboard CTA expects `/vetrina-presentation.html`; setup-guide.test.mjs expects old guide text and old presentation link. All involved tests and source files are byte-identical to HEAD. Not changed to avoid unrelated scope.
- Development HTTP checks: `/intro.html`, `/assets/deck/logo.png`, `/vetrina-deck.html`, `/vetrina-guide.html`, `/vetrina-presentation.html` all return 200, with responses byte-identical to local public files.
- Supplied HTML equality checked after reversing only the logo URL substitution.
- Browser visual rendering at phone/desktop sizes has not been verified; DOM/CSS checks are not a substitute for visual review. No production build or production deployment claimed.

## Approval gate
Proposed production URL after approved merge/deploy: https://vetrina-app-wheat.vercel.app/intro.html

Prepared for review; full-suite caveats and pending visual review noted above. Do not merge or deploy to production without explicit user approval. No Vercel project, domain, environment, or build settings changed.
