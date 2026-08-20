<!--
SPDX-License-Identifier: LicenseRef-OpenLBM-Docs-1.0
SPDX-FileCopyrightText: 2026 FutureBuild, Inc. and OpenLBM contributors
-->
# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What Is This?
GableNow is an **AI-native procurement portal** for contractors buying from LBM (lumber & building materials) suppliers. Logged-in contractor experience only — there is no marketing website and no shopping cart, by design.

The product replaces product-pages-and-carts with a **Procurement Board**: `Plan → Quote → Order → Invoice`.

- **Plan** — draft jobs with prospective orders, delivery dates, and account/rule-based pricing.
- **Quote** — push to the supplier's quote desk (required when scope has non-priced/special-order lines); then build a *contractor-branded* customer quote (markup + labor + overhead) shared via a one-time link the homeowner can review/accept.
- **Order** — converts to sales orders with delivery/will-call tracking.
- **Invoice** — AR, including offline/counter-sale invoices. Saved payment methods, few-click payment.

**Contractor adoption is the #1 KPI.** UI/UX quality outranks feature breadth. Mobile-first, desktop-capable.

> Status: **M9 complete** — board, order workspace, project drill-down, ERP simulator, customer quotes, order tracking, AR/Pay, the AI assistant, catalog-as-a-destination, and a production host (`server/serve.ts`). What is *not* built — starting with any integration at all with the `gable` ERP — is listed in [ROADMAP.md](ROADMAP.md), which is the plan of record. `docs/five-year-strategy.md` is a strategy note, not a commitment.

## Commands
```bash
npm install
npm run dev        # Vite dev server (falls through to :5174/:5175 if 5173 is taken)
npm run build      # tsc -b && vite build — the pre-flight check
npm run typecheck  # tsc --noEmit
npm test           # vitest run (watch: npm run test:watch)
npm run check      # biome check --write . (format + lint)
```
Single test: `npx vitest run src/core/lib/__tests__/money.test.ts` (or `-t "name"`).

**All four gates must pass before any commit**: `typecheck`, `test`, `build`, `check`.

Three more run on demand, and each exists because it caught something the four
could not:

```bash
npm run a11y      # axe over every screen, both apps, at phone width
npm run security  # boots a real dev server and attacks it
npm run e2e       # drives the product as a contractor, against a prod build
```

`npm run e2e` is journeys, not components — the unit tests cover the pieces,
and every serious bug this project has had lived in the seams between them: a
proxy that aborted itself, branding that never applied, a permission gate that
switched off after a partial restore. It fails on any uncaught error or 404,
which is how a missing favicon surfaced.

### The user guide is part of "done"
`docs/user-guide.md` is an end-to-end walkthrough with screenshots, and it must
be **updated at the end of every milestone** — new flows documented, the
"what isn't built yet" table moved on, and screenshots regenerated:

```bash
npm run guide      # rebuilds, walks the app, rewrites docs/screenshots/
```

`scripts/capture-guide.mjs` drives real interactions (including the drag-and-drop)
against a production build using the locally installed Chrome, and **fails loudly
when a screen it expects is missing** — so it doubles as a smoke test and cannot
silently capture the wrong screen. Screenshots are palette-quantised on the way
out, because the guide is regenerated every milestone and full-size 2x PNGs
would add megabytes to history each time.

## The one architectural rule that matters

**`src/core/` is framework-free. Zero React imports. No exceptions.**

Everything that touches the domain, an ERP, pricing, or an AI tool lives in `src/core/` as plain TypeScript. `src/ui/` is thin React that renders core state and calls core actions. This is deliberate: v1 is React for UX velocity, but the distribution target is embeddable web components (Lit). When that migration happens, only `src/ui/` is rewritten.

Enforced two ways — a Biome `noRestrictedImports` override for `src/core/**`, and `src/core/__tests__/architecture.test.ts`, which greps every core file for banned specifiers. The test exists because a lint rule can be disabled inline and a test cannot. It has been verified to fail on a real violation.

The only file that knows about both worlds is `src/ui/hooks/useStore.ts` (`useSyncExternalStoreWithSelector`). Keep it that way.

## Layout
```
server/claude-proxy.ts      # Vite dev middleware + host-agnostic proxyClaude(); keeps the API key server-side
src/
  core/          # FRAMEWORK-FREE
    lib/         # money (integer cents), ids, result, rng (seeded), time
    stores/      # createStore (get/set/subscribe) + normalized Collection helpers
    data/        # salvaged catalog JSON (25 products, 26 categories, 12 brands, 4 BoM templates)
    domain/      # catalog, project (Project/Order/ScopeItem), stage machine, totals, account
    sim/         # the supplier's ERP: pricing engine, clock, scheduler, quote desk,
                 #   order lifecycle. Writes supplier-side facts only.
    actions/     # THE single mutation path — UI buttons and (from M8) AI tools both call these
    selectors/   # read models (board cards, columns, project rollups)
    boot.ts      # wires catalog -> pricing -> scenario -> stores, once
    ai/          # tools (the registry), prompt (the brief), session (the loop)
  ui/
    styles/theme.css   # the design system (see below)
    hooks/useStore.ts  # the ONLY React↔core bridge
    layouts/  pages/  components/   # shell, board, sheets
    App.tsx
```

## Conventions

- **Money is always integer cents** (`src/core/lib/money.ts`). Never floats. `toCents` scales through the decimal string, not `* 100`, because `1.005 * 100 === 100.49999999999999` would round a half-cent the wrong way. The seed converts the catalog's float dollars once, at the boundary.
- **Actions return `Result<T>`, they don't throw.** The error string is shown to the user on a rejected board drop *and* handed to the AI verbatim as a `tool_result` so the model can self-correct. Throwing loses that symmetry.
- **All randomness goes through `rngFor(seed, key)`** (`src/core/lib/rng.ts`), never `Math.random`, so demos replay identically. Sub-streams are keyed by entity id so values don't shift with call order.
- **Timestamps are ISO strings**; state must stay JSON-serializable for localStorage. Nothing in core reads the wall clock — sim time comes from `SimClock` so demos can run at 600× and survive a reload.
- **Store snapshots are immutable.** `set` must produce a new object; `useSyncExternalStore` compares by reference.
- Path aliases `@/*`, `@core/*`, `@ui/*` are configured in `tsconfig.json`, `vite.config.ts`, and `vitest.config.ts` — keep all three in sync.

## The brand kit

**GableNow** is the product; **Gable Supply** is the demo dealer. The two share
a mark on purpose — a gable roof over a widening stack of boards, three strokes
in `currentColor` so it takes whatever brand the dealer configured.
`components/brand/GableMark.tsx`, and the same geometry in `public/favicon.svg`.

**The dealer's colour lives in `domain/config.ts`, NOT in theme.css.** The
config is injected as `:root:root` and deliberately outranks the stylesheet, so
a dealer's configured colour always wins; theme.css only holds the fallback for
a build with no config. Changing the brand in theme.css alone looks like it
worked and does nothing — the running app still shows the config's colour.

Gable Supply's ochre is `oklch(52% 0.14 62)`, and the lightness is the
load-bearing part. `--brand` is used BOTH as text (active nav, chip labels) and
as a fill under white text, so it has to clear 4.5:1 in both directions. It
measures **5.72 each way**, beating the blue it replaced. A brighter, more
"hi-vis" amber at 62% lightness looks right and measures **3.76** — failing
both ways at once.

The neutrals were rewarmed from hue 260 to ~70 to sit with it. Lightness was
untouched, so the measured three-step text hierarchy is intact: **17.75 / 7.45
/ 5.50** against `--surface`. Signal and stage tokens are unchanged — they were
measured for their own reasons and a warm brand is not one of them.

The mark sits beside the DEALER's name in the sidebar, not the product's. On a
white-label deployment the contractor is looking at their supplier's portal;
"GableNow" is our name for it, not theirs.

## Design system (`src/ui/styles/theme.css` is the only source of truth)
"Daylight Pro" — **light-first**, high-contrast, because contractors use this in trucks and direct sun. Dark mode is first-class (`:root[data-theme="dark"]`), not an afterthought.

Three token layers, and the distinction is load-bearing:
1. **Platform** (`--surface`, `--text`, `--stage-*`) — never dealer-overridable, so "Order" looks the same across every dealer.
2. **Dealer** (`--brand-*`) — the supplier's brand, set at runtime from branding config.
3. **Contractor** (`--cbrand-*`) — used *only* on customer-facing quote pages, where the contractor's brand must beat the dealer's.

Tokens are OKLCH and are bridged into Tailwind utilities via `@theme inline` (so `bg-surface`, `text-text-muted` work). Tailwind v4 — there is no `tailwind.config.js`; theme lives in CSS.

Money and quantities use `tabular-nums` globally so figures don't jitter. `.text-data` is the mono treatment for SKUs/PO/SO numbers.

## AI proxy
`ANTHROPIC_API_KEY` is deliberately **not** `VITE_`-prefixed so Vite never inlines it into the bundle. `vite.config.ts` reads it via `loadEnv` and hands it to `claudeProxyPlugin`. The client calls `/api/anthropic/v1/messages` with a placeholder key; the proxy swaps in the real one and pipes SSE bytes back.

- `GET /api/anthropic/health` → `{ok, hasKey}`. Reports whether a key is configured at all — the env var or the dealer's stored key. The client renders the assistant disabled when it is false (there is intentionally **no** mock-echo fallback — a fake assistant would undermine the one thing that must be real).
- The proxy enforces a model allowlist and a `max_tokens` ceiling so a leaked endpoint can't become an open relay.

## Repo history notes

**This repository has no pre-migration history, on purpose.** `gable-portal` was
populated from the `futurebuildai/lumbernow` working tree — files only, no
commits. Nothing before the first commit here is an ancestor, and there is no
archive branch in this repository to go looking for.

That is a deliberate trade, and what it costs is worth naming: the original
history's commit messages were the record of *why* most invariants in this file
exist. When a comment below says "this bug shipped once", the evidence lived in
a commit message that is not here. The comments were kept precisely because they
are now the only surviving copy of that reasoning — **treat them as load-bearing
and do not tidy them away.**

What the clean start bought:

- **Two artifacts could not follow.** The old history carried a 16 MB compiled
  `backend/api` binary and a tracked `frontend/.env.production` containing a
  Vercel OIDC token — scoped to a development environment of an abandoned
  project, and already expired. Neither exists here. A fresh tree ends that
  class of problem by construction rather than by a filter-branch nobody trusts.
- **A torn-down prototype could not follow either.** The pre-teardown product
  was a Lit 3 + Go stack with a Postgres schema and a real auth model; it was
  removed and the catalog data salvaged. The current tree is the rebuild. If you
  are looking for the takeoff math or the "quote artifact → approve → stage"
  interaction, it is not in this repository.
- `.gitignore` uses `.env.*` with a `!.env.example` exception specifically so a
  tracked env file cannot recur. **Never loosen that pattern.**

## Deployment

**Not Vercel** — that path is abandoned. Do not reintroduce a Vercel-shaped
`api/` directory.

`server/serve.ts` is the production host: a plain `http.createServer`, no
framework. It mounts the exact same `createMessagesHandler` and
`createAdminHandler` dev already uses — they were host-agnostic `(req, res) =>
void` functions from the start, built and tested that way, specifically so
this file could stay small. It adds only what dev got from Vite for free:
static file serving (`dist/assets`, `dist/images`, bounds-checked against
`dist/` so `..` cannot escape it) and per-request config injection into the
two HTML entry points.

- **Build**: `npm run build && npm run build:server` (esbuild bundles
  `serve.ts`; every server/core import is already relative, so there are no
  path aliases to resolve — the same property that lets `tsc` type-check them
  today). **Run**: `npm run serve`, or `node dist-server/serve.mjs` directly.
  `PORT` and `HOST` are configurable; `HOST` defaults to `127.0.0.1` since
  whatever fronts this (a tunnel, a reverse proxy) connects locally, and
  binding wider only adds LAN exposure with no benefit.
- **The HTML entry points are templates, not static files.** `vite build`
  bakes in whatever config was on disk at BUILD time. Serving that file
  unmodified would mean a dealer's branding change in the admin console never
  reflects — nothing re-renders the file. `serve.ts` reads each HTML file
  ONCE at startup, strips the baked-in config block, and re-injects a fresh
  one (via `renderConfigTags`, the same function the dev plugin uses) on
  EVERY request. Verified: `curl` against a running instance shows the
  brand colour changing immediately after a `PUT /api/admin/config`, no
  restart.
- **`npm run predeploy` is the gate**, `scripts/prod-server-smoke.mjs` —
  security-smoke.mjs's twin for this host, since they share almost nothing at
  the implementation level (no Vite, no middleware stack, a hand-rolled static
  server) and a defence proven for one says nothing about the other. Building
  it caught a real false green: the first version of the traversal test used
  only a `.gablenow/secrets.json` canary, and `.json` is not in the server's
  MIME allowlist — every attempt was blocked by the EXTENSION filter alone,
  and deleting the bounds check (`candidate.startsWith(DIST)`) entirely left
  every assertion green. A second canary with an allowed extension
  (`.html`) sitting one level above `dist/` tests the bounds check on its own
  merits; reintroducing the bug now fails it. The admin-auth checks are
  verified the same way — bypassing `authorize()` flips them red.
- **Real deployment, not just a preview.** `dist/index.html` and
  `dist/admin.html` differ from the dev-served versions in one way worth
  remembering if this file is ever touched: they contain a build-time
  config snapshot that `serve.ts` must strip before re-injecting, or the
  page would render the stale snapshot underneath a fresh one appended after
  it — two `window.__GABLENOW_CONFIG__` assignments, last one wins by
  accident rather than by design.

## The domain model (M1)

Two levels, and the split is the product:

```
Project  "Wilson Custom Home"    — the site. Address, client. Has NO stage.
  Order  "Framing package"       — a procurement unit. THIS is the board card.
  Order  "Roofing"                 One delivery date, one fulfillment method,
  Order  "Trim"                    its own stage.
```

Board cards are **Orders**, not Projects. A project's orders can sit in four
different columns at once; the Project view is the drill-down that shows them
together. This is why every card has exactly one unambiguous stage — there is no
"which stage is this half-delivered job in" question to answer.

`ScopeItem` is a line on an order and carries a **frozen snapshot** of the
product (name, sku, image). Deliberate: a quote already sent to a homeowner must
not silently change because the dealer edited the catalog.

### Stage rules (`domain/stage.ts`)
The quote desk is a **gate, not a toll booth**:
- A fully ERP-priced order may go **straight Plan → Order**. That is the whole
  promise of account pricing; routing everyone through a sales desk would
  recreate the friction this product exists to remove.
- An order containing a **special-order line** (`SO-` sku, no ERP price) **must**
  be quoted first — otherwise the contractor commits to a number nobody stood behind.
- **Invoice is the supplier's move.** A contractor cannot drag a card there;
  the sim advances it once the order is delivered and billed.
- Every rejection returns a contractor-readable sentence. That string is shown
  verbatim on a rejected drop *and* handed verbatim to the AI as a `tool_result`.

### Pricing lives in the ERP, not the domain
`sim/pricing.ts` holds tiers, category rules, contract prices, and volume
breaks. The domain has none of it — the contractor sees a resolved `PriceQuote`
(their price, list price, next volume break) and nothing about how it was
computed. When a real ERP connects, that file is replaced by an API call
returning the same shape and **nothing in `domain/` changes**.

Precedence: contract SKU > account category rule > tier category rule > tier
baseline > list. **Category rules cascade down the category tree** — "18% off
Lumber" must reach a product in Framing Lumber two levels below, so always pass
`categoryParentsFrom(categories)` to `createPricingEngine`.

### The catalog seed manufactures inventory
The salvaged JSON has `inStock` on 8 of 25 products and a `leadTime` field that
is really a stock *status* ("Low Stock — Order Soon"). Lead-time risk is a
headline feature, so `data/catalog-seed.ts` invents the missing stock and lead
times **deterministically from a seeded RNG keyed by SKU** — same seed, same
catalog, every run. Seed choice matters for demos: it decides how many items are
out of stock and therefore how much the lead-time warnings have to bite on.

## The board (M2)

`src/ui/pages/BoardPage.tsx` → `components/board/Board.tsx`. Two layouts, and
**exactly one is mounted at a time** via `useMediaQuery(DESKTOP_QUERY)`. Do not
switch this back to Tailwind's `hidden lg:grid`: keeping both mounted doubles
the DOM on a phone *and* registers the mobile and desktop drop targets under the
same dnd-kit ids simultaneously, which makes drop resolution ambiguous.

- **Mobile** — one stage at a time; `StageBar` is both the navigation and, mid-
  drag, the drop-target row. Four columns on a 390px screen is ~90px a card,
  which is unreadable, so the columns become tabs.
- **Desktop** — the familiar four-column kanban.

**Invalid drops are accepted, not blocked.** Every stage is a droppable even when
the rules will reject the move; the rejection opens `StageTransitionSheet` with
the stage machine's own sentence. Disabling invalid targets prevents the mistake
but teaches nothing — the contractor just finds the card won't go. Valid targets
are highlighted; invalid ones are dimmed but still land.

Guard messages are contractor-facing copy, so they conjugate ("1 item **needs**",
"2 items **need**"). There are tests for that; keep them.

## Conventions added in M2

- **`exactOptionalPropertyTypes` is on.** It is genuinely useful in the domain
  (absent vs. explicitly-`undefined` changes what gets JSON-serialized), but it
  fights React, where optional props legitimately receive `undefined`. Declare
  UI props as `foo?: T | undefined`. Do not turn the flag off to avoid this.
- **Persistence is debounced (250ms) with an explicit `flushPersistence()`**,
  wired to `pagehide` in `main.tsx` so the last action before a tab closes isn't
  lost. `boot()` disposes the previous run's subscriptions — Demo Reset re-boots,
  and without that each reset would stack another writer on the same key.
- **Seeded demo data is priced through the real ERP engine**, never hand-written
  numbers, so scenario totals can't drift from what the app would compute.
  `src/core/data/scenario.ts` is built to exercise every rule: a clean order that
  can skip the quote desk, one with a special-order line that can't, an order with
  no date, an empty draft, and one project (Wilson) with orders in three stages
  at once.

## Scope editing (M3)

`OrderPage` → `LineItemRow` + `AddItemsSheet`, over `actions/scope.ts` and
`selectors/order.ts`. Routes are real (react-router) because on a phone the
hardware back button must return to the board, not exit the app — and M5's
`/q/:token` share page needs somewhere to live.

Rules worth keeping:
- **Adding a SKU that's already on the order bumps its quantity** rather than
  creating a second line. Two lines for one product is a data-entry mistake, and
  it would hide a volume break the combined quantity qualifies for.
- **Changing quantity re-asks the ERP for a price**, because volume breaks make
  price quantity-dependent. Crossing a break flashes the new unit price — hiding
  it would defeat the one piece of pricing mechanics this product exposes.
- **Scope locks once the supplier has the order** (`quote`, `order`, `invoice`).
  Editing underneath a dealer who is already pricing or picking is how disputes
  start. Pull it back to Plan to edit.
- **Special-order lines are captured unpriced**, with a generated `SO-` sku. That
  is what makes the quote-desk gate fire, and it means a contractor whose scope
  includes a custom door doesn't have to leave the portal.

### Volume breaks: absolute vs relative
A break is either `{minQty, unitPrice}` or `{minQty, extraPercentOff}`, and the
distinction is load-bearing. **An absolute break price is only valid on a rule
that names a single sku.** A category spans a $6 stud and a $30 post, so a
category-wide absolute price produced "buy 94 more of this $24.58 post and it's
$4.28 each" — visibly fake numbers. Category breaks must be relative; the engine
resolves them against each product's own base price. The engine ignores an
absolute break attached to a category rather than trusting it.

**A contract price does not stack with a category volume break** — it's locked by
negotiation, and discounting it further double-dips the dealer. A volume rule
naming that same sku *does* apply, since that's a deliberate volume tier on the
contracted item.

## The simulator (M4)

`src/core/sim/` plays Gable Supply. It is the only thing that writes
supplier-side facts — quotes, sales orders, invoices, tracking events — and
handlers reach the stores through the narrow `SimStores` façade in `sim/types.ts`
rather than calling contractor actions, whose guards are meant for a human.

**How work gets scheduled.** `scheduler.ts` holds a persisted queue of future
tasks keyed by sim time. Persisted deliberately: close the tab mid-quote and the
work continues, because on boot everything already due runs immediately in dueAt
order. That is "it happened while you were away" for free. The pump is bounded
to 50 passes so a handler that schedules something already due can't spin.

**Stage effects are the bridge.** `canMoveToStage` returns `StageEffect[]`;
`moveOrderToStage` runs them against the sim. That is why a drag causes real
supplier work — and why the stage machine stays pure and testable.

**Timing honesty rules** (`sim/config.ts` holds every delay):
- The quote desk takes ~90 min to acknowledge and ~5 h to price. An instant
  answer reads as a machine, and the premise is that a person priced it.
- Nothing dispatches before the contractor's requested date. A truck arriving a
  week early looks broken, not fast.
- A will-call order parks at `ready-willcall` rather than pretending someone
  collected it.
- Special-order prices are anchored on what the description sounds like (a door
  is not priced like a bracket) and jittered via `rngFor`, so a demo replays
  identically but the numbers aren't suspiciously round.

**Demo controls, not fake speed.** `sim.control` exposes speed presets, `skip a
day`, and `skipToNextEvent()` — which jumps the clock to the exact moment the
next task is due. The delays stay realistic; only the clock moves. This is what
makes a nine-day delivery watchable without lying about it.

**Invoicing moves the card.** When the sim invoices a sales order it calls
`advanceOrderToInvoice`, which is the only stage change the simulator may make —
mirroring the rule that a contractor cannot drag a card into Invoice.

Notifications live in `activityStore` behind an unread count. There is
deliberately no toast per sim event: at speed they'd be a firehose.

## Customer quotes (M5)

`domain/customer-quote.ts` + `actions/customer-quote.ts` + `pages/QuoteStudioPage`
(contractor) and `pages/CustomerQuotePage` (public, `/q/:token`).

**Two clocks, and they interact.** Supplier pricing expires (`ScopeItem.priceExpiresAt`,
14 days, set by the quote desk) and the contractor's proposal expires
(`CustomerQuote.validUntil`). The customer quote is **capped by the earliest
supplier expiry** (`supplierPriceHorizon`) and re-capped on every update —
promising a homeowner longer than the dealer is holding puts the price movement
on the contractor. Price expiry is a domain concept, not a display detail:
`isPriced(item, now)` and `needsQuoteDesk(items, now)` treat a lapsed line as
unpriced, so **an expired price re-blocks an order that was previously
placeable**. `StageContext` carries `now` for exactly this reason.

**Selections vs commodities** (`Product.presentation`). A homeowner chose the
decking; they did not choose the joist hangers. Selections carry imagery,
description, and specs onto the customer quote; commodities are summarised.
Classification is derived in the seed — and the NAME is the reliable signal, not
tags: pressure-treated joists are tagged `deck` because they frame one, which
put a hero image of a 2x6 next to the decking. Dimensional-lumber names
(`\d+x\d+`) are commodity unless they're decking/trim/fascia/siding/rail.

**Acceptance requires a signature.** `QuoteAcceptance` stores the typed legal
name, the drawn mark, the verbatim consent text shown, and the total agreed to —
frozen. A boolean would be worthless if the contractor ever had to stand behind
the claim. A quote also **freezes at send** (lines re-snapshotted) and
**rotates its token on re-send**, so a superseded link goes dead.

The share page forces its own light palette and never renders supplier identity
or contractor cost.

## Tracking and AR (M6, M7)

`OrderTrackingPage` + `selectors/tracking.ts` + `actions/fulfillment.ts`;
`PayPage` + `selectors/ar.ts` + `actions/payments.ts` + `domain/payment.ts`.

- **Will-call substitutes `ready-willcall` for `out-for-delivery`** in the step
  flow rather than defining a second flow constant.
- `confirmWillCallPickup` cancels the sim's pending auto-collect task, or it
  fires later and appends a second "delivered" event plus a duplicate invoice.
- Rescheduling **re-times the already-scheduled dispatch task** — otherwise the
  new date is cosmetic and the truck still rolls on the old one. Blocked once
  out for delivery: moving a truck already rolling is a phone call, not a form.
- **`payInvoices` returns `ok()` on a decline.** The action succeeded; the
  payment failed. A decline is data the UI must render — `err()` would throw
  away the `Payment` record. `pm_bad` always declines, because a demo that only
  shows the happy path teaches nothing.
- `quotePayment` is shared between the sheet's display math and `payInvoices`
  validation so the number shown and the number charged can't drift.
- Card fee (2.9%) is shown per method **before** choosing. That difference is
  real money.

### The seeded scenario must be internally consistent
Two bugs in a row came from the same root: a card in a stage with no supplier
artifact behind it. An Invoice-stage card with no `Invoice`, then an Order-stage
card with no `SalesOrder` (so nothing to track, and no supplier status chip).
`buildScenario` now returns `invoices` and `salesOrders` for every card it
starts past Plan — **if you add a seeded card in a later stage, seed its
artifacts too.**

**Bump `SCHEMA_VERSION` when the seed gains data an existing demo would never
see.** A browser holding older state restores straight past the seeding block;
that is correct for user data and wrong for demo data, and the version bump is
the intended escape hatch. It went to 2 for the AR/sales-order seed.

Tests must look supplier artifacts up **by orderId, not by index** — the seed
now occupies the first slots.

## The assistant (M8)

`core/ai/{tools,prompt,session}.ts` + `ui/components/assistant/AssistantSheet.tsx`.

**Scope is narrower than "AI does everything," deliberately.** The assistant's
main job is turning a material list the contractor *already has* — typed,
dictated, photographed, or a PDF — into structured lines bound to real SKUs.
Generating a takeoff from dimensions is a separate embeddable widget and is
explicitly out of scope; the system prompt says so, and says **never invent or
adjust a quantity**. That distinction is what makes the output verifiable: the
parsed lines land in a Plan-stage order the contractor reviews before anything
reaches the supplier.

**Every mutating tool calls the same action a button calls.** This is the whole
security model. The assistant cannot reach a code path the contractor can't,
can't bypass a stage guard, and can't invent a price. When an action refuses,
the refusal sentence goes back to the model as the `tool_result` verbatim — the
same words the board shows on a rejected drop — so the model self-corrects using
contractor-facing language instead of a paraphrase.

**Three tiers** (`ToolTier`): `read` runs silently, `write` touches only the
contractor's own draft, and `commit` — quote desk, placing an order, sending a
customer quote, paying — **suspends the loop** for approval. That suspension is
why `session.ts` hand-writes the agentic loop instead of using the SDK's tool
runner: the pause spans a UI round trip of arbitrary length. Every `commit` tool
must supply `confirm()`; there is a test for it, because the fallback prompt
("Run pay_invoices?") names no amount.

**The catalog is inlined in the system prompt** (~25 products) because seeing
every option at once beats iterative search for SKU matching. `search_catalog`
stays as the durable interface for a real dealer catalog that won't fit.

Model is `claude-opus-4-8` with adaptive thinking and `effort: high` — a wrong
SKU match has real consequences. Streaming throughout.

### The loop is tested without a key
`AssistantSession` takes an optional `fetch` (`SessionOptions`) so
`ai/__tests__/session.test.ts` can replay canned SSE: tool dispatch, the commit
gate, the verbatim refusal relay, the turn cap, and attachment blocks. That test
immediately caught a bug no unit test of ours would have: the SDK builds request
URLs with `new URL()`, so a relative `baseURL` of `/api/anthropic` throws
"Invalid URL" before a byte goes out. `proxyBaseUrl()` makes it absolute against
`location.origin`. **The live model round trip is still unverified** — it needs a
real key.

### With no key, the assistant is disabled, not faked
`GET /api/anthropic/health` is checked once at boot. There is intentionally no
mock-echo fallback: a fake assistant would undermine the one part of this
product that has to be real. The disabled state is captured in the guide.

### Disabled must look disabled
A filled brand button at `opacity-45` still reads as clickable in daylight — the
keyless Send control looked perfectly live. Filled `Button` variants now drop
their fill and go grey when disabled. Fade is not a state; colour is.

## The L8 review remediation (post-M8)

A full-branch adversarial review (9 auditors, every finding verified by two
skeptics) confirmed 31 defects; all are fixed and pinned by
`src/core/__tests__/review-regressions.test.ts` — **each test there reproduces
a confirmed finding; if one fails, that bug is back.** The invariants that came
out of it:

- **The stage machine sees the supplier.** `StageContext.supplierStatus` feeds
  the pull-back guard: an order that is out-for-delivery or delivered cannot be
  dragged back to Plan (cancelling it would erase a bill for goods on site).
  Every `canMoveToStage` caller must pass it. `updateOrder` refuses logistics
  changes (`requestedDate`/`fulfillment`/`poNumber`) once the supplier holds
  the order — the reschedule action exists to re-time the actual work.
- **Chained sim tasks anchor to `task.dueAt`, never `clock.now()`.** The two
  coincide while the tab is open; after a day offline they differ by a day, and
  now()-anchoring advanced fulfillment one step per reload. There is a
  regression test that reboots across a two-day gap; keep it honest. Demo
  controls (`setSpeed`/`advance`) persist the FULL clock anchor synchronously —
  a torn {old anchor, new speed} pair replayed at 3600x was +75 days on reload.
- **The quote desk re-prices expired lines.** `priceSource === 'quoted'` alone
  does not mean priced — check `isPriceExpired` too, or the "send it back for a
  fresh price" remedy loops forever.
- **Cross-tab is real now, not a comment.** `attachCrossTabSync` adopts other
  tabs' storage writes (echo-proof: browsers never fire `storage` in the
  writing tab); a heartbeat lease (`gn:leader`) makes exactly one tab pump the
  simulator. This is what makes the two-window accept demo true — before it,
  two schedulers double-fired every task and the second tab could clobber a
  signed QuoteAcceptance.
- **Restore is validated, all-or-nothing.** Every persisted key must pass shape
  validation or the whole save is stashed (`gn:corrupt-backup`), wiped, and
  reseeded — restoring half a save is how cards end up with no supplier
  artifact. Boot self-heals (wipe + reseed on throw) and `ErrorBoundary` keeps
  a recovery path on screen. A missing `MIGRATIONS` step means "reseed on
  purpose"; only add one when old state can truly carry forward.
- **A customer quote refuses unpriced lines** (`unitCost ?? 0` on a signed
  proposal is the contractor's loss), **freezes at every status past draft**,
  and reopens only through `reviseCustomerQuote`, which rotates the token
  IMMEDIATELY — the old link dies when intent to change forms, not at re-send.
- **Commit confirms name the charged amount.** `pay_invoices`' prompt is built
  from `quotePayment` (fee included, ids deduped) — the same function the
  action charges through, so shown and charged cannot drift.
- **`daysPastDue` is THE definition of late.** `isOverdue` and `agingBucket`
  both derive from it; they used to disagree for the first 24h past due on the
  same screen.
- **The session survives failure.** `cancel()` aborts the stream and resolves a
  waiting commit-confirm as declined (closing the sheet cancels — a hidden
  agent must not keep mutating). After any error the history is repaired so
  role alternation and tool_use/tool_result pairing stay legal — without that,
  one 429 bricked the session until reload. Old attachments are pruned to text
  placeholders so photos aren't re-shipped every turn.
- **The proxy is same-origin only, rate-limited, and abort-propagating** —
  client hangs up, upstream stops billing. Mid-stream failures destroy the
  socket instead of throwing through `sendJson` after headers are sent.

## Team roles (post-M8)

`domain/team.ts` (roles + capability matrix) + `actions/team.ts`
(`requireCapability`, the gate) + `pages/TeamPage.tsx` + `components/team/*`.

**Four roles, because a six-person outfit is not one login:** owner, project
manager (`pm`), accounts payable (`ap`), field. Only ACTIONS are gated —
everyone reads everything, because hiding information from your own crew
creates more phone calls than it prevents.

**The gate lives in the actions layer**, which is why it is one rule and not
three: buttons, board drags, and every AI tool call pass through the same
`requireCapability` and get the same refusal. **The refusal names who CAN do
it** ("Only Dana Reyes or Robin Alvarez can make payments — you're in as
Marcus Webb (Project manager)") because "not allowed" leaves someone stuck and
"ask Robin" solves it. That sentence reaches the model verbatim too, so the
assistant tells the contractor who to ask instead of retrying.

- **With no team seeded, everything is allowed.** The gate exists once people
  exist, so an embed of the core without the team feature costs nothing and
  the pre-existing tests never had to change.
- Invariants: the company can never lose its last owner, and the person
  currently acting cannot be removed.
- The switcher IS the demo's login story — `activeId` is persisted state that
  every permission check reads, so a reload keeps the hat on.
- `SCHEMA_VERSION` went to 3 for the seeded crew.

## The mobile UX pass (post-M8)

Driven by a screenshot-based audit (7 auditors reading the real rendered
guide PNGs, then a framer-persona and a design-system judge ranking each
finding). Principles that came out of it, worth keeping:

- **Say the consequence, not the arithmetic.** The lead-time chip read
  "23d lead vs 9d out" — two abbreviations and a subtraction. It now reads
  "Can't make Aug 9 — 23d lead".
- **Photos are information.** Board cards and catalog search rows carry the
  real product images (frozen `snapshot.imageUrl`); "the decking order" is
  recognised by picture faster than by two truncated text lines.
- **Never render a confident wrong number.** An empty draft shows "—", not
  a $0.00 that reads as an order worth nothing.
- **A remedy named in prose should be a button.** The blocked-move sheet
  offers "Send to quote desk" and re-enters the same confirm flow.
- **Destructive and irreversible need a way back**: line removal is undoable
  from the toast (raised to z-60 so feedback clears the z-50 sheets), and
  Demo Reset arms before it fires.
- **Colour must encode state, and never alone.** The tracking pill maps
  status → success/info/neutral instead of one blue for everything; a thin
  margin gets an icon as well as a warning hue.
- **Teach the mechanic in place.** The Pay bar is always visible and reads
  "Select invoices to pay" when nothing is ticked; empty board columns name
  the press-and-hold gesture.
- **A destructive path with a way back needs it on EVERY path.** Removing a
  line by stepping the quantity to zero was undoable; the detail sheet's
  "Remove from order" button — the more deliberate of the two — just flashed
  "Removed from order" and the line was gone. Both go through one `removeLine`
  now. Two code paths to the same destructive outcome is how a documented
  guarantee quietly stops being true.
- **An unknown total is not zero.** `subtotal` sums only priced lines, so an
  order awaiting the quote desk on every line rendered "$0.00" directly above
  "1 item still needs dealer pricing". `hasKnownSubtotal()` lives in
  `domain/totals.ts` because the board card and the order page both decide this
  and must not diverge.
- **Disabled must look disabled everywhere, not just in `Button`.** The
  homeowner's "Accept & sign" was a raw button using `disabled:opacity-40` on a
  filled accent — the exact fade-not-colour anti-pattern the shared `Button`
  had already fixed, on the one screen where someone decides to spend money.
- The signature pad clears only on a genuine WIDTH change — the mobile
  keyboard fires resize with the same width, and wiping a finished signature
  because someone tapped the name field is unforgivable.


## The AI key belongs to the DEALER

`core/ai/byok.ts`, `KeySheet.tsx` and the contractor-facing key row are gone.
The Anthropic credential is configured once by the dealer in the admin console,
the dealer unlocks the assistant feature, and the dealer carries the bill.

A browser-held key was right while this was a developer tool and wrong for a
deployed product: it puts a live credential in every contractor's
localStorage, spreads the blast radius of a leak across every device someone
signs in on, and leaves the dealer unable to see or cap what is spent in their
name.

- **Deleting the client is not closing the door.** The proxy no longer reads a
  forwarded key at all, and `claude-proxy.test.ts` pins that: a request
  carrying the old `x-anthropic-byok` header spends the DEALER's key, and with
  no dealer key configured it gets a 503 rather than spending the caller's.
  The endpoint is what an attacker talks to, not the UI.
- **Usage is counted per contractor account, and the cap is per account.** A
  single shared counter answered "is anyone using this?" but not "should I
  raise the cap for one crew?", and let one busy contractor lock every other
  one out for the rest of the day.
- **Attribution, not authorization.** The account id rides on the request, so
  it says who CLAIMS to be spending. `normalizeAccountId` bounds length and
  charset and rejects `__proto__`/`constructor`/`prototype` — the first of
  those passes a plain charset check and then stops behaving like a key, so
  the count silently vanishes into the prototype chain. Real per-tenant
  enforcement needs authenticated sessions, which this demo does not have.
  Do not mistake this counter for a security control.
- A contractor with no key sees who to ask, not a field they cannot fill.
- **A "daily" cap means the DEALER's day, not UTC.** `usageDay()` uses the
  server's local date. UTC rolls over mid-afternoon or evening everywhere west
  of Greenwich — in Ontario the cap lifted at 8pm and the console's usage went
  to zero while the yard was still open, so a contractor capped at lunchtime
  got a fresh allowance over dinner. A dealer in a different timezone from
  their server needs a configured timezone, but UTC is the one guess that is
  wrong for almost everybody.

## Conventions from the correctness sweep

- **`.dom.test.ts` is the escape hatch, and it is narrow.** The `core` vitest
  project runs in node so a stray `document` cannot pass a test and then fail
  in a Lit build. A core module that genuinely needs a browser API (storage
  events, `matchMedia`) gets a `.dom.test.ts` and runs in the jsdom project —
  which the node project must **explicitly exclude**, since `*.test.ts` matches
  it too and it would otherwise run in both and fail on a missing `window`.
- **Who you are is per window.** `attachCrossTabSync` deliberately does NOT
  adopt the `team` store. `activeId` is who YOU are acting as in THIS tab, and
  adopting it wholesale meant a contractor's window silently became A/P because
  someone switched people in another one — which then changes what every button
  will let them do. Supplier and quote state still follow; that is the feature.
- **Three text steps must be three steps.** `--text-muted` and `--text-subtle`
  sat at 50% and 52% lightness — a hierarchy nobody could see, created by
  raising `subtle` for AA. `muted` moved down instead, because `subtle` carries
  the 11px chip text and needs the contrast it has. 17.6 / 7.4 / 5.5 against
  `--surface`, all **measured** with `npm run contrast`, which paints to a
  canvas and reads the pixel — `getComputedStyle().color` now echoes
  `oklch(...)` back unchanged, so parsing it as `rgb()` reads lightness as red.
- **An audit that cannot see the screen must fail, not shrug.** `npm run a11y`
  waited on `page.locator(sel).first()`, which at 390px resolved to the
  desktop-only sidebar — permanently invisible. It timed out on every run,
  printed a warning, and audited anyway, reporting "0 violations" for a page it
  never confirmed had rendered. It now filters to `visible=true` and **throws**.

## Catalog as a destination (M9)

`selectors/catalog.ts` + `pages/CatalogPage.tsx`. The Catalog tab was a
placeholder; it is now the yard, priced for the contractor.

**The price is the whole difference.** `AddItemsSheet` shows LIST and says so —
it is a fast way to find a SKU mid-order. Browsing answers a different
question: what does this cost ME. A catalog showing list would be a price book,
and a contractor already has one of those. Pricing is injected the same way
`buildOrderDetail` takes `quoteFor`, so core stays free of the ERP.

- **Search spans the whole catalog even with a category selected**, and the
  category chips hide while searching. Filtering a search by the aisle someone
  is standing in is how you type a SKU off a delivery note and get told it does
  not exist. There is a test, and it needed fixing: picking "the first
  top-level category that isn't the target's" can land on the target's own
  PARENT, so the test passed with the bug reintroduced until it checked the
  subtree explicitly.
- **A category filter includes descendants.** Same cascade as the pricing
  rules — "Lumber" must reach a stud two levels down or the parents look empty.
  `categoryAndDescendants` is cycle-safe because the category data is
  hand-editable.
- **Empty categories are not offered.** The salvaged catalog carries aisles the
  dealer does not stock; "Appliances 0" led to a blank list and made the whole
  tree look unreliable.
- **There is no cart, so adding ends in an order picker.** Materials belong to
  an order and an order to a job. Only Plan-stage orders are offered — scope
  locks once the supplier holds it, and offering a locked order then refusing
  the add teaches the rule the hard way. The confirmation carries the jump to
  that order rather than just naming it.
- **One sheet at a time.** Opening the picker on top of the product sheet
  stacked two overlays and the upper one swallowed every tap — the picker was
  on screen and completely unusable. Found by driving it; no test would have.

## The dealer's name is configuration, not a literal

`companyName` was settable in the admin console while the demo dealer's name
was hardcoded into ~40 contractor-facing sentences, so a deployment for anyone
else still told its contractors that "Gable Supply will price this". Every such
sentence now goes through `supplierName()` (`core/config/runtime.ts`).

- **Build the sentence where it is rendered.** Module-level string constants
  freeze at import, before the admin preview can re-read the config —
  `STAGE_BLURB`/`STAGE_EMPTY` became `stageBlurb()`/`stageEmpty()` for exactly
  that reason. The one deliberate exception is AI **tool descriptions**, which
  are evaluated once at module load; they say "the supplier's catalog" and the
  system prompt (rebuilt per request) names the dealer.
- One rename is a bug, forty is a class of bug, so `review-regressions.test.ts`
  greps the whole tree with comments stripped and fails naming the offending
  file. `domain/config.ts` is the single place the demo name may appear.

## The dealer admin console (post-M8)

`admin.html` + `src/admin/` + `server/{admin-api,admin-store,admin-plugin}.ts`
+ `core/domain/config.ts` + `core/config/runtime.ts`.

A **different user from the contractor**: the dealer's own staff, configuring a
deployment after it ships rather than a developer configuring it in code.

**Two stores, two files, on purpose.** `.gablenow/config.json` is PUBLIC —
every value in it is served to every visitor, because it is branding, terms,
and flags. `.gablenow/secrets.json` (0600) holds the LLM credential and has
no route out of the process. They are separate FILES, not separate keys, so a
mistake that serialises "the config" cannot serialise the secret: `DealerConfig`
has no field that could carry one. There is a test that asserts a payload
trying to smuggle a key lands nowhere.

**The credential is write-only.** `PUT /api/admin/credential` validates the key
against Anthropic (a 1-token request) BEFORE storing it, so a dealer learns
about a bad paste immediately instead of through a contractor's failed message.
Nothing returns it — the admin UI gets `present` and a mask. A test walks
several routes asserting the key never appears in any response body.

**The gate fails closed.** No `GABLENOW_ADMIN_TOKEN` means every admin request
is refused; undefined must never mean "no check". Compared with
`timingSafeEqual`, loopback-only unless `GABLENOW_ADMIN_ALLOW_REMOTE=true`.
It is a development gate and says so in its own docstring: one shared secret,
no identity, no audit, no rotation. The upgrade path is to replace
`authorize()` alone.

**Branding must win on SPECIFICITY, not order.** The bundler injects theme.css
AFTER the injected `<style>`, so a plain `:root` selector loses the cascade and
the dealer's colour silently never applies — which is exactly what happened
first time, and only a computed-style check in the browser caught it.
`brandingCss` emits `:root:root` (and `:root:root[data-theme="dark"]`) and a
test pins that. Config is INJECTED into the document rather than fetched, so
there is no flash of default branding on every load.

**Only the dealer token layer is writable.** Colour values are validated
against a strict hex/oklch pattern and refused otherwise — these strings are
interpolated into a stylesheet, so an unvalidated one is CSS injection that
could rewrite the PLATFORM layer a dealer is explicitly not allowed to touch.
Refusing is verifiable; escaping is not.

**Feature flags gate presentation only.** A hidden Pay tab is not a permission
— the actions layer still guards every mutation. A flag must never be the only
thing between a contractor and a mistake.

### Config writes are optimistic-concurrent, and the counter always counts
A save replaces the WHOLE config, so two admins with the console open silently
overwrote each other — the second save simply erased the first with nothing on
screen to suggest it had. `/state` now returns a `revision` (a hash of the
PARSED config, so reformatting the file by hand is not mistaken for someone
else's edit) and `PUT /config` requires it as `if-match`. A **missing** header
is refused exactly like a stale one: a caller that sends none cannot have read
the current state. The console turns the 409 into "reload and re-apply".

The console also stopped throwing away edits typed **during** a save. It
adopted the server's copy unconditionally when the round trip returned, which
discarded those keystrokes and cleared `dirty`, so it looked saved and the work
was gone. It now adopts only if the draft is byte-identical to what it sent.

`consumeDailyQuota` counts before it enforces. Returning early when no cap was
set meant a default deployment reported "Used today: 0" forever — which reads
as "nobody used the assistant", not "nobody is counting", and that number is
exactly how a dealer decides what the cap should be.

### The admin bundle is separate, and that is load-bearing
`admin.html` is a second Vite entry (`build.rollupOptions.input`), so admin
code does not ship inside the contractor bundle — the one headed for embeddable
web components on a dealer's own site. Verified: `dist/assets/admin-*.js` is
~12 KB and the contractor bundle contains none of it.

### Never read the dealer key ambiently
`createMessagesHandler` takes an injectable `dealerKey()`. It used to call
`readStoredKey()` directly, which coupled the proxy to whatever the admin test
suite had left on disk — the two suites went FLAKY against each other through
the `byok > dealer > server` precedence (1 failure in 3 runs, passing the rest).
A test that passes by scheduling luck is worse than one that fails.

`/api/anthropic/health` counts the dealer key too (`apiKey || readStoredKey()`).
Reporting only on the env var meant a dealer who configured a validated,
paid-for key in the console still saw the assistant render disabled. It stays a
bare boolean — that route is unauthenticated.

### The dev server's API was dead, and every check said 200

The worst bug of the whole post-M8 stretch, and it shipped: **every API route
in the dev server** — health, `/api/config`, the Claude proxy, and the entire
admin console — answered `200 <!doctype html>` to any request carrying a
browser's default `Accept` header.

Two constraints pull in opposite directions. Middleware must sit AFTER
`viteHostCheckMiddleware` (the DNS-rebinding defence; registering in the
`configureServer` body puts it in FRONT), and BEFORE
`viteHtmlFallbackMiddleware`, which **rewrites `req.url` to `/index.html`**
whenever `Accept` contains `text/html` or `*/*`. Connect matches routes on
`req.url`, so after that rewrite `/api/admin/state` no longer matches
`/api/admin` and the request sails into the SPA. Returning a post-hook
satisfies the first and violates the second. `server/dev-middleware.ts`
registers in the post-hook and then **relocates the layers to just before the
fallback**, asserting both anchors exist so a Vite upgrade fails loudly instead
of silently killing the API again.

Why nothing caught it, which is the part worth remembering:
- The SDK sets `Accept: application/json`, so the one path with a test kept
  working. `curl` with no `-H` sends `*/*` and got HTML.
- The proxy and admin suites mount their handlers on a bare
  `http.createServer` — they never see Vite's stack at all.
- **The security smoke asserted `status === 200`.** The SPA fallback answers
  200. "200 means mounted" was never true, and three checks stayed green
  through a total outage. They are content-based now, and they fail with
  `got 200 <!doctype html>`.

`server/__tests__/dev-middleware.test.ts` drives a real Vite dev server and
asserts on BODIES across three `Accept` values. Verified by reintroducing the
bug: 5 of 9 fail, and the `application/json` case still passes — which is
precisely the blind spot that let this live.

## The first save must be complete

`attachPersistence` writes a store when it CHANGES, which is right for user
data and wrong for the seed: on a fresh demo nothing ever changed `projects`,
`orders`, or `scope`, so they were never written at all. Building and sending a
customer quote wrote `customerQuotes` and `activity`, and a SECOND tab then
loaded a save that had a quote but no core trio, failed the trio check in
`restorePersisted`, reseeded from scratch, and lost the quote. The share link
opened on "This link is no longer valid" — the two-window accept demo, broken
on every fresh install.

`boot()` now writes every persisted store synchronously once seeding is done.
**A save must be complete from the first moment another tab could read it.**

Two things kept this hidden, and both are worth remembering:
- It **self-healed on any reload**. Reloading the contractor tab persisted
  everything, and the link started working — so it only ever reproduced on a
  first run, which is exactly the run a new user gets.
- The first regression test for it **passed with the bug reintroduced**, twice.
  It called `flushPersistence()`, which writes EVERY attached store
  unconditionally — the test's own setup manufactured the complete save it then
  asserted on. `src/core/__tests__/first-save.test.ts` is a separate file that
  must never call it, for that reason.

## A gate must know it is grading its own program

This bit twice, in two different scripts, and the second time it corrupted
documentation across repos.

`npm run security` and `npm run guide` each spawn a server and then talk to a
fixed port. Neither checked that the spawn actually won that port, and
`server.kill()` reaps only the `npx` wrapper — the real vite child keeps
listening. So a run leaves a server behind, and the next run, in ANY checkout,
silently talks to it.

The guide case is the one to remember: a preview server left over from the
sibling product answered every page, and an entire user guide was captured from
a DIFFERENT APPLICATION. The screenshots looked completely plausible. Nothing
failed. The only reason it surfaced was reading the regenerated PNGs and
noticing the wrong dealer name.

Both scripts now:
- refuse to start if anything is already listening on their port,
- abort if their own server exits before serving,
- spawn `detached` and kill the process GROUP, then wait for the port to
  return so a re-run does not trip its own guard,
- and the guide additionally asserts the served `<title>` matches this repo's
  own `index.html` — a port guard stops the common case, content proves it.

**A check that can silently grade the wrong program is worse than no check.**

## The checks that are not `npm test`

```bash
npm run a11y      # axe over every screen, both apps, at phone width
npm run security  # boots a real dev server and attacks it
npm run e2e       # walks the app as each role against a production build
npm run contrast  # measures colour pairs through a browser's own pipeline
```

They all fail loudly, and they all exist because they caught things unit tests
structurally cannot. Every serious defect in this stretch — the proxy outage,
the dev-server API outage, the branding cascade failure, the served secrets
file, the DNS-rebinding bypass, the palette failures — was invisible to both
unit tests and code review, and visible within seconds of running the real
thing. **Reading the code is not verification.**

**`npm run a11y`.** The palette itself failed WCAG AA on nine screens —
`--text-subtle` at 3.36:1, every stage colour, `--warning` at 2.73:1 — in a
product whose stated premise is reading a phone in direct sun. Every signal
token is now MEASURED, through a canvas in a real browser, because two attempts
at doing the colour maths by hand were both wrong. Each token clears 4.5:1
three ways: as text on a card, as text on the 14% tint chip of its own hue, and
as the fill under white pill text. One value covers all three, since darkening
a token also lightens the tint derived from it.

Two things the palette could not fix: role avatars put brand-coloured initials
on a tint of the same hue (4.43:1, and the owner tint derives from a
DEALER-set `--brand`, so no fixed value was safe) — initials are near-black
now, and colour carries the role without carrying the text. And board cards
were nested interactive controls, because dnd-kit's attributes gave the wrapper
`role="button"` around a card that was already one; the drag props go on the
card itself.

**`npm run security`.** Two real vulnerabilities, both verified live:

- **The credential was served as a static file.** `.gablenow/` lives inside
  the Vite root, so `GET /.gablenow/secrets.json` returned the dealer's
  Anthropic key over plain HTTP — no token, no loopback check, the entire
  write-only design defeated by a path guess. Fixed with `server.fs.deny`,
  which covers static serving, `/@fs/`, and the transform pipeline. **The
  patterns must be `**/.gablenow/**`** — Vite matches absolute paths, and a
  bare `.gablenow/**` matches nothing, which is exactly how the first fix
  failed silently.
- **API middleware sat in front of Vite's DNS-rebinding defence.** Vite
  installs `hostCheckMiddleware` AFTER `configureServer` hooks run, so anything
  registered in the hook body escapes it: `Host: evil.com` was 403 on `/` and
  200 on the key-spending proxy. `crossOrigin()` cannot catch this — it
  compares Origin against the client-supplied Host, and under rebinding those
  agree. Both plugins now register from the function `configureServer`
  RETURNS, which Vite runs behind the host check.

Two lessons worth keeping. **Node's `fetch` silently drops a forged `Host`
header** (undici treats it as forbidden), so the first version of the rebinding
test asserted nothing and passed — it uses raw `http.request` now. And **assert
on content, not status**: the SPA fallback answers 200 for unknown paths, so
"`.git/config` returns 200" proved nothing; the check greps for git content,
and the credential checks grep for a canary.

### A gate must know it is grading its own program

`npm run security` spawned `npx vite` and never checked that the spawn won the
port. A leftover dev server from a SIBLING CHECKOUT was still listening, so a
whole run attacked that server instead — grading a different application. It
surfaced as a false red, but the same path yields a false green just as easily:
a hardened stale server while the code under test is wide open.

Two fixes, and the second caused the first:
- The smoke refuses to start if anything is already listening on its port, and
  aborts if its own dev server exits before serving.
- `server.kill()` reaped only the `npx` wrapper and left the real vite child
  holding the port. It spawns `detached` and kills the process GROUP now, then
  waits for the port to come back so a re-run does not trip its own guard.

Verified both ways: occupied port exits 1 with a message naming the problem,
free port exits 0.

### Other invariants from that review
- **Usage accounting never touches the credential file.** It used to
  read-modify-write `secrets.json` on every assistant request, and
  `readSecrets` degraded to `{}` on any read error — so one transient EMFILE
  wrote that `{}` back and destroyed the dealer's key. Counting lives in
  `usage.json`; `readSecrets` now throws rather than pretending a present-but-
  unreadable file is empty.
- **A bad config field costs that field, not the config.** One hand-edited
  colour used to revert EVERY setting to defaults — lifting the spend cap and
  re-enabling every feature flag. Only a non-object payload is refused now.
- **Only a 2xx proves a key.** `keyWorks` treated any non-401 as valid, so a
  429 during an Anthropic incident stored an unverified key under a UI that
  promised it had been checked. Unreachable now refuses with a 503.
- `max_tokens` is rounded, not just clamped — a fractional value 400s every
  request, and the proxy rejects non-integers too.

### The SDK is loaded on demand
`session.ts` imports `@anthropic-ai/sdk` dynamically: it is ~30% of the
contractor bundle and nothing needs it until someone actually sends a message —
on a deployment where the dealer disabled the assistant, never. 493 KB → 338 KB
(145 KB → 103 KB gzipped). `describeError` uses the SDK's real classes once the
module is in memory and falls back to the wire shape otherwise: duck-typing
alone failed, because the SDK does not set `name` on its error classes, so an
APIConnectionError arrived as a bare "Error".
