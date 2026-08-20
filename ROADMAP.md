<!--
SPDX-License-Identifier: LicenseRef-OpenLBM-Docs-1.0
SPDX-FileCopyrightText: 2026 FutureBuild, Inc. and OpenLBM contributors
-->

# Roadmap

**Last reviewed: 2026-08-20.** This is the plan of record and the honest
inventory of what does not exist. It is deliberately written so that reading
only the first two sections tells you whether this repository can do the thing
you want.

`docs/five-year-strategy.md` is a *strategy note* — a market thesis synthesised
from a research panel. It is not a commitment and nothing in it is scheduled.
Where the two disagree, this file governs.

---

## Where this actually is

**A working prototype with production-grade engineering discipline and no
production surface area.**

Both halves of that are true and neither should be discounted. The engineering
is real: 449 tests (446 passing, 3 deliberately-failing and documented in §6),
`strict` TypeScript with `noUncheckedIndexedAccess` and
`exactOptionalPropertyTypes`, an architectural boundary enforced by a test
rather than a convention, five browser-driven audit gates, and a domain layer
whose comments record the specific bug each invariant was written for. The
money path — `money.ts`, `totals.ts`, `selectors/order.ts`, `selectors/ar.ts`,
`domain/customer-quote.ts` — is at 100% statement coverage. The product is not:
there is no server, no database, no login, and no ERP.

If you are evaluating this to run a business on, the answer today is no. If you
are evaluating it as the contractor-side design and domain model for the Gable
ecosystem, it is further along than most things at this stage.

---

## Known problems we are not hiding

### 1. There is no integration with `gable`. None.

This is the largest gap and it is not partial. There is no API client, no
adapter, no shared type package, no authentication handshake, and no agreed
contract with the host ERP. `src/core/sim/` is a *simulator* that plays the
supplier: it prices, it runs a quote desk, it ages orders, it issues invoices.

The domain layer was built anticipating this — `sim/pricing.ts` carries a
comment stating that when a real ERP connects, everything in that file is
replaced by an API call returning the same `PriceQuote` and nothing in
`domain/` changes. That is a *design intention*, not a tested claim. Nobody has
tried it.

There is also an unresolved question underneath: `gable` already contains
portal-shaped surfaces at `app/src/pages/portal/` and
`backend/internal/portal/`. Which repository is the portal, and which is the
seam, has not been decided.

**Nothing else on this roadmap matters as much as this.**

### 2. No backend, no database, no authentication

All state is in the browser's `localStorage` under the `gn:` prefix, with
versioned migrations, cross-tab adoption via `storage` events, and a
heartbeat-renewed leadership lease so exactly one tab pumps the simulator. That
machinery is genuinely well built. It is also, structurally, a single-user
single-browser toy.

Consequences, all current:

- Clearing site data loses everything.
- Two people cannot share a board.
- There is no audit trail anyone could rely on.
- The team/role gates in `src/core/actions/team.ts` are **UX guardrails, not a
  security boundary**. Anyone with DevTools can edit the store.
- A signed customer quote is a `localStorage` record. It would not survive
  contact with a dispute.

Do not deploy this with real data. See [SECURITY.md](SECURITY.md).

### 3. `public/images/brands/` depicts trademarks we do not own

Nine images depict the marks of Weyerhaeuser, Georgia-Pacific, LP, YellaWood,
Arauco, GAF, Owens Corning, Trex, Simpson Strong-Tie, and Quikrete. They are
**AI-generated placeholders**, not the manufacturers' artwork, and they exist so
the demo catalog reads like a catalog. They are also 1024×1024 JPEGs with a
`.png` extension, which is its own small lie.

Before this repository is promoted anywhere public-facing, they should be
replaced with generic imagery or removed and the brand cards rendered as
initials. This is tracked here rather than quietly ignored because a
source-available repository shipping imitations of live trademarks is a real
exposure, not a cosmetic one. See [LICENSE-MAP.md](LICENSE-MAP.md).

### 4. The branch model in the docs does not match the repository

[CONTRIBUTING-WITH-CLAUDE.md](CONTRIBUTING-WITH-CLAUDE.md) — which ships as part
of the committed contributor kit — instructs contributors to open pull requests
against `staging`, which maintainers then fast-forward to `master`. This
repository's default branch is `main`, and neither `staging` nor `master`
exists.

`.github/workflows/ci.yml` already triggers on all four names so CI will not
need editing. Someone has to decide whether to cut the branches or amend the
kit. Until then, branch from `main` and open against `main`.

### 5. `.github/CODEOWNERS` names teams that do not exist

`@FutureBuildAIinc/maintainers`, `/frontend`, and `/legal` are placeholders.
GitHub **silently ignores** CODEOWNERS entries for teams without write access,
so a missing grant looks exactly like "nothing happened". The file documents
what a maintainer must do before opening the repository to outside
contributors.

### 6. Two defects found while writing tests, asserted and marked failing

Both are pinned by tests in
`src/core/selectors/__tests__/order-money.test.ts` and
`src/core/actions/__tests__/orders.test.ts`, written as `it.fails(...)` with the
*correct* behaviour asserted, so fixing the code turns them green rather than
requiring the test to be rewritten.

- **`breakOpportunity.savesCents` can be negative.** In
  `src/core/selectors/order.ts`, `savesCents` is
  `costNow - (breakUnitPrice × breakMinQty)`. Buying up to a volume break
  normally costs more in total even though the unit price drops, so a field
  named "saves" routinely holds a negative number. No UI renders it today, which
  is the only reason this has not surfaced in front of a contractor — but it is
  a public field on a money-facing selector, and the comment directly above it
  describes the opposite intent. The fix is a decision, not a typo: either
  rename it to a signed delta, or clamp and omit the opportunity when it is not
  actually a saving.
- **`reorderInStage()` has no permission gate and reports a `sortOrder` it did
  not persist.** Every other mutation in `src/core/actions/orders.ts` opens with
  `requireCapability(...)`; this one does not, so a Field-role user is refused a
  stage move and allowed a reorder. It also returns
  `{ ...order, sortOrder: newSortOrder }` while writing the post-splice index,
  so an out-of-range argument makes the returned object disagree with the store.
  The function currently has **no callers** — board drag-and-drop goes through
  `moveOrderToStage` — which is why neither has bitten. It is exported from the
  core API surface, so it will.

### 7. The five real gates are not in CI

`npm run a11y`, `npm run security`, `npm run predeploy`, `npm run e2e`, and
`npm run contrast` each boot a server and drive it with a real browser. Each has
caught a defect the four CI gates could not — `e2e` found a missing favicon
through its 404 rule; `predeploy` found a false green in `security`'s own
traversal test. They are not in CI because a flaky browser launch failing an
unrelated PR trains people to ignore CI.

That reasoning is sound and the result is still a gap: they run only when
someone remembers. A scheduled advisory job is the likely answer.

### 8. Smaller things, honestly listed

- **Single dealer per deployment.** `DealerConfig` is one JSON file in
  `.gablenow/`. There is no tenant concept anywhere.
- **USD and `en-US` only.** `formatCents` hardcodes an `Intl.NumberFormat`.
  There is no i18n layer and no locale plumbing to add one to.
- **`formatCentsCompact` rounds to one decimal above $1,000.** `$12.5k` on a
  board card is intentional density, but it is a rounded number sitting where a
  contractor might read a total. It is only used on cards; keep it that way.
- **`src/ui/pages/` is near-zero coverage.** Deliberate — those components
  render numbers already asserted in core — but it does mean a rendering
  regression would be caught by `e2e` or by nobody.
- **No error reporting, metrics, or telemetry of any kind.** Fine for a
  prototype; the first thing a deployment needs.
- **The Anthropic model is a config default** (`claude-opus-4-8` in
  `DEFAULT_CONFIG`). Model names age; there is no validation that the configured
  model exists.

---

## What is built, so the gaps have a scale

Everything below works, is tested, and is walked end-to-end with screenshots in
[docs/user-guide.md](docs/user-guide.md).

| Area | State |
|---|---|
| Procurement Board (Plan → Quote → Order → Invoice) | Drag-and-drop, stage machine with refusal reasons, per-column ordering |
| Project drill-down | A job's orders across several stages at once |
| Order workspace | Line editing, catalog search, special-order lines, lead times, volume-break prompts |
| Pricing engine | Tier baseline, account and tier category rules cascading down the category tree, locked contract SKUs, absolute and relative volume breaks, precedence rules |
| ERP simulator | Quote desk with price expiry, order lifecycle, scheduler that catches up on time passed while the tab was closed |
| Customer quotes | Contractor markup + labor + overhead, one-time share link, signature capture, frozen acceptance |
| Order tracking | Delivery/will-call, reschedule, timeline |
| AR and payments | Invoices including offline counter sales, saved methods, card fee disclosure |
| AI assistant | Tool layer bound to the same guarded actions the buttons call; disabled and visibly disabled without a key |
| Dealer admin console | Separate bundle, branding, terms, feature flags, write-only credential store, optimistic-concurrent config writes, daily request cap |
| Team and roles | Owner / purchaser / field / A-P, refusals that name who *can* act |
| Production host | `server/serve.ts` — plain `http.createServer`, bounds-checked static serving, per-request config injection |

---

## What is next, in order

Nothing here has a date. This is sequence, not schedule.

### Now

1. **Decide the `gable` seam.** Which repository owns the contractor portal, and
   what the contract between them is. Everything else is blocked on this.
2. **Freeze `sim/`'s facade as a published adapter contract**, and turn its
   behavioural test suite (`sim/__tests__/pricing.test.ts`,
   `sim/__tests__/lifecycle.test.ts`) into the conformance harness a real ERP
   adapter must pass — pricing precedence, category cascades, expiry
   re-blocking, lifecycle events. This is the highest-leverage step available
   *before* the seam decision, because it makes the simulator an asset rather
   than a prop.
3. **Fix the two defects in §6**, or consciously decide not to and say why.
4. **Replace `public/images/brands/`.**

### Next

5. **A server.** Nothing on this list past here is meaningful without one:
   identity, persistence, and an audit trail. This is where the portal stops
   being a prototype.
6. **The first real adapter.** BisTrack has the largest independent footprint,
   so it is the obvious first target — with a design-partner dealer, not
   speculatively.
7. **Web components.** The stated direction is that a dealer's web person drops
   the board into their own site. `src/core/` being framework-free is what makes
   this a rewrite of `src/ui/` rather than of everything, and that boundary is
   already enforced and tested. Nothing else has started.

### Later

8. **Capture as the front door** — camera and voice into priced Plan-stage
   lines, offline-first queueing.
9. **Deposit at signature** — the customer-quote acceptance ceremony already
   freezes scope, price, and consent; taking a deposit at that moment is the
   nearest real money moment.
10. **The price-lock book** — `priceExpiresAt` already exists on every
    desk-quoted line and the domain already treats a lapsed price as unpriced.
    Managing those as one queue across every job is a small feature on top of
    machinery that is already there.

### Explicitly not planned

- **A shopping cart or a catalog-first funnel.** The product thesis is that
  those are why contractors abandon dealer e-commerce.
- **AI-generated takeoffs from drawings.** A separate product. The standing rule
  — *never invent a quantity, never invent a price* — is not negotiable, and a
  takeoff that guesses is exactly that.
- **Autonomous ordering.** The assistant drafts; a person approves. Shipping an
  "auto-order" toggle and getting one $12k truckload wrong would cost more trust
  than the feature could ever earn back.

---

## Contributing to any of this

See [CONTRIBUTING.md](CONTRIBUTING.md). If you want to work on something in the
"Now" list, open an issue first — those items have architectural decisions
attached, and it would be a shame for you to write the code before the decision
is made.
