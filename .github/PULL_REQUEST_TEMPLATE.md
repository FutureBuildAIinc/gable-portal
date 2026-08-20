<!--
SPDX-License-Identifier: LicenseRef-OpenLBM-Docs-1.0
SPDX-FileCopyrightText: 2026 FutureBuild, Inc. and OpenLBM contributors
-->

## What this changes

<!-- One paragraph. What behaviour is different after this merges? -->

## Why

<!-- The problem, and why this is the right shape of fix. Link the issue if
     there is one. -->

## Gates

All four must be green locally before review. CI runs the same four
(`.github/workflows/ci.yml`), plus the REUSE licensing gate.

- [ ] `npm run typecheck`
- [ ] `npm run lint` — this is `biome check .` with no `--write`. Run
      `npm run check` first if it complains about formatting.
- [ ] `npm test`
- [ ] `npm run build`

If you touched `server/`, the admin console, or anything that serves a file:

- [ ] `npm run security` (boots a dev server and attacks it)
- [ ] `npm run predeploy` (the same, against the production host in
      `server/serve.ts` — it shares almost no implementation with the dev
      server, so a defence proven for one says nothing about the other)

If you touched a screen:

- [ ] `npm run a11y`
- [ ] `npm run e2e`
- [ ] `npm run guide` if a documented flow changed — `docs/user-guide.md` and
      its screenshots are part of "done", not a follow-up.

## Money

<!-- Delete whichever does not apply. -->

- [ ] **This PR does not touch money.**
- [ ] **This PR touches money** — a price, a quantity, a total, a fee, a
      discount, a saving, or what a contractor or homeowner is committed to.

If it touches money, answer these:

- Which of `money.ts`, `totals.ts`, `sim/pricing.ts`, `domain/project.ts`
  (`itemExtended` / `isPriced`), `selectors/order.ts`, `selectors/ar.ts`, or
  `domain/customer-quote.ts` did you change?
- Is every amount still integer cents end to end? No float dollars may cross a
  boundary except at the seed, which converts once.
- Which test asserts the new arithmetic? Paste its name. A PR that changes a
  number without a test that would fail on the old number will be asked for one.
- Do the board card and the order page still agree? They read the same
  `orderTotals`; if you added a code path that recomputes a total anywhere
  else, that is the thing to justify.

## Licensing

- [ ] Every new file carries an SPDX header, or a `.license` sidecar if its
      format cannot hold a comment (`.json`, `.png`).
- [ ] The header matches [`LICENSE-MAP.md`](../LICENSE-MAP.md) — code is
      `LicenseRef-OpenLBM-Community-Source-1.0`, prose and repo plumbing are
      `LicenseRef-OpenLBM-Docs-1.0`.
- [ ] `.css` headers use `/* */`, not `//`. PostCSS rejects `//` and the build
      fails outright.
- [ ] I have the right to contribute this, and I agree it is licensed under the
      license that governs the file(s) I changed. See
      [CONTRIBUTING.md](../CONTRIBUTING.md).

## Secrets

- [ ] No `.env`, no API key, no token, no real customer or dealer name, and no
      internal hostname is in this diff — including in a test fixture. Fixtures
      use obviously-fake values (`sk-ant-api03-serverserver...`).

## Screenshots

<!-- For any visible change. Phone width matters as much as desktop: the
     product is mobile-first and the layout branches at 768px. -->
