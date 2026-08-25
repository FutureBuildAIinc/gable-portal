<!--
SPDX-License-Identifier: LicenseRef-OpenLBM-Docs-1.0
SPDX-FileCopyrightText: 2026 FutureBuild, Inc. and OpenLBM contributors
-->

# Roadmap

**Last reviewed: 2026-08-24.** This is the plan of record and the honest
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
is real: 618 tests, all passing (see §6 for the three that used to be pinned),
`strict` TypeScript with `noUncheckedIndexedAccess` and
`exactOptionalPropertyTypes`, an architectural boundary enforced by a test
rather than a convention, five browser-driven audit gates, and a domain layer
whose comments record the specific bug each invariant was written for. The
money path — `money.ts`, `totals.ts`, `selectors/order.ts`, `selectors/ar.ts`,
`domain/customer-quote.ts` — is at 100% statement coverage.

**What changed:** there is now a real ERP behind it, if you point it at one.
Sign-in, catalog, customer-specific pricing, order submission and order status
were wired first; the quote desk, order cancellation, delivery-reschedule
requests, job history, lead times, volume breaks, the category tree and a
conditional change feed followed once `gable` grew the endpoints for them. All
of it is verified against a seeded Postgres rather than a mock. §1 has the
transcript and the exact list of what is wired, what each capability is allowed
to claim on screen, and what is still missing.

What is still missing: the portal has no persistence of its own, so the board
around those ERP-backed facts still lives in `localStorage`. There is no audit
trail. A signed customer quote is still a browser record.

If you are evaluating this to run a business on, the answer today is still no —
but the question is now "what else does it need", not "does it connect to
anything".

---

## Known problems we are not hiding

### 1. The `gable` integration — wired, with the edges named

**This section used to say there was no integration at all, and then that the
spine was wired and the edges were not. Both were true when written. Neither is
now, and a stale honesty surface is worse than never having written one.**

Set `GABLE_API_URL` and the portal runs against a real `gable` at
`/api/portal/v1/*`. Leave it unset and `src/core/sim/` plays the supplier
exactly as before — a supported mode, not a degraded one, and what keeps the
pre-existing suite meaningful.

`sim/pricing.ts` has carried a comment since M1 saying that when a real ERP
connects, everything in that file is replaced by an API call returning the same
`PriceQuote` and nothing in `domain/` changes. Somebody has now tried it. The
claim held: `src/core/supplier/port.ts` is the interface, `supplier/sim.ts` and
`gable/supplier.ts` are the two implementations, `actions/` calls neither
directly, and every pre-existing test passes unchanged through the added call
frame.

#### Verified against a live `gable` and a seeded Postgres

Not a mock. `gable` booted with `AUTH_MODE=production` so the **real**
`NewPortalAuthMiddleware` was in the path — not the dev-mode branch that injects
Sam Kelbrook into every request and would have made a login "succeed" no matter
what was sent.

- `demo@kelbrook.ca` with the wrong password → 401, `GableAuthError`, one
  request issued and no retry.
- The same email with `password` → 200, `portal_token` cookie set
  (`HttpOnly; SameSite=Strict; Path=/api/portal`), **no token in the response
  body**.
- `GET /catalog` → 71 products, which is exactly what the portal then rendered.
  `CORN2006` list $23.25 → `2325` cents, customer price $23.24 → `2324` cents,
  `price_source: PROMOTIONAL`.
- Checkout → `orders` row `b75c496c-de6c-4113-a786-b034a86da81c`,
  `customer_id 6d949033-…` (Kelbrook Construction), `total_amount 341.88`, and
  two `order_lines` (`CORN2006 x12 @ 23.24`, `CORN2009 x12 @ 5.25`) — read back
  out of Postgres directly, not inferred from a 200.
- The dealer then moved that order `DRAFT → CONFIRMED` **in the database**, and
  the portal's next read showed `confirmed / GBL-b75c496c`, note "Gable Lumber &
  Supply reports this order as CONFIRMED", subtotal `34188` cents. No timer was
  involved; the simulator's scheduler was stopped.
- With `GABLE_API_URL` unset the same build reports
  `{"ok":true,"gable":"standalone"}`, injects `{"wired":false}`, and the full
  pre-existing suite passes.

#### The eight capabilities, verified against the same live `gable`

Real transcript, `AUTH_MODE=dev` on the seeded Postgres, `35` portal routes
registered. Every number below was read back out of the database or off the
wire, not inferred from a 200.

- **Quotes.** `POST /quotes` with a catalog line and a special-order line
  created `ccf43bf8-…` — `quotes.source = 'portal'`, `state = 'DRAFT'`,
  `total_amount 0.00`, and two `quote_lines` at `unit_price 0.0000`
  (`CORN2006` and `SPECIAL-ORDER`). Accepting it unpriced: **409**
  `QUOTE_NOT_PRICED`. The dealer then priced it in the ERP (`state SENT`,
  `total_amount 1700.00`) and the portal read back `priced: true`,
  `unit_price 6.25` on the catalog line and `1450` on the custom door, with the
  contractor's own `customer_note` untouched. Accepting the priced quote:
  **200**, `erp_state ACCEPTED`. Accepting it again: **409**.
- **project_id.** `PUT /orders/{id}/project` returned
  `project_name "West Kelowna Medical Plaza"`, `orders.project_id` matched in
  the database, `GET /orders?project_id=` returned exactly that order, and an
  explicit `{"project_id": null}` detached it. A checkout carrying
  `project_id` produced `a9c9f813-…` already filed against the job.
- **Cancellation.** A portal-placed order: **200**,
  `{"status":"CANCELLED","previous_status":"DRAFT"}`, `orders.status` CANCELLED
  in the database. The same cancel again: **409** `ORDER_ALREADY_CANCELLED`. A
  FULFILLED order on a COMPLETED route: **409** `ORDER_IN_MOTION`. Another
  customer's order id: **404**, never 403.
- **Reschedule.** `POST /deliveries/{id}/reschedule` → **202**,
  `applied: false`, `status PENDING`, `current_scheduled_date "2026-08-13"`.
  The `delivery_routes` row was `SELECT`ed before and after and is
  **byte-for-byte identical** — same `scheduled_date`, same `updated_at`. The
  ask landed in `portal_delivery_reschedule_requests` as PENDING; asking again
  moved the first to SUPERSEDED rather than leaving two dates in the queue. A
  DELIVERED stop on a COMPLETED route: **409** `DELIVERY_COMMITTED`. A delivery
  never rescheduled: **204**, not 404.
- **Lead time.** With one product published at `0` and one at `7`, the wire
  carried `{"zero":1,"positive":1,"null_":82}` — `CORN2006: 0`,
  `CORN2009: 7`, `CORNCLEAR: null`. Three states, three values.
- **Volume breaks.** With no dealer rule the ladder is `[]`. After the dealer
  published QUANTITY_BREAK rules at 100 and 500,
  `GET /catalog/{id}/volume-breaks` returned **one** rung —
  `{"min_quantity":500,"unit_price":4.1,"price_source":"QUANTITY_BREAK","saves_per_unit":0.36}`.
  The 100 rung was dropped by `gable` because at that quantity it did not beat
  this customer's TIER price, which is the ladder behaving correctly.
- **Category tree.** `GET /catalog/categories` returned the real hierarchy —
  Lumber (19) over Framing/Sheathing/Engineered, Hardware (8) over
  Fasteners/Connectors, plus Roofing (13), Insulation (3), Concrete, General.
  `?category_id=<Hardware>` narrowed 84 products to **8**, matching the
  subtree count on the node.
- **Change feed.** First read: `ETag "2f4305839ec4aaf82882539b2dd28bb5"`,
  `X-Portal-Latest-Change 2026-08-25T01:48:24.858566Z`,
  `Cache-Control: private, no-cache, must-revalidate`, 7 orders. With
  `If-None-Match`: **304, 0 bytes**. `?since=<cursor>`: `[]`. The dealer then
  moved one order to `ON_HOLD` in the database; `?since=<cursor>` returned
  exactly that one order, and the stale ETag went back to 200. A fresh
  validator 304s again.

#### Two of these are wired against demo data that does not exercise them

Not defects, and worth stating so nobody concludes the wiring is broken from a
demo:

- **Every product in the seed has `lead_time_days` NULL.** `gable_fresh` ships
  68 products and none of them publishes a lead time, so a wired portal shows
  "your supplier has not published a lead time" on all of them and the
  lead-time warnings stay silent everywhere. That is the correct rendering of
  the data; it is also invisible proof. A dealer publishing one number makes
  the whole path visible.
- **The seed's 136 QUANTITY_BREAK rules mostly do not beat this customer's own
  price.** `gable` drops a rung that is not strictly cheaper than the
  single-unit price, and Kelbrook's TIER and CONTRACT pricing already beats most
  of them — so most ladders come back `[]`. Publishing one rule that genuinely
  undercuts the tier produced a real rung immediately.

#### A defect this found in `gable`, reported and not worked around

**Cancelling a CONFIRMED order returns 500 on the seeded database.**
`order.CancelOrder` releases the allocation for every line of a CONFIRMED
order, and `inventory.Release` fails with `no allocated stock found for
product …` when the order never held one — which is true of the seeded
CONFIRMED orders and of any order confirmed outside the allocating path. The
customer sees `INTERNAL_ERROR`, and the order is correctly left alone by the
transaction.

It is a `gable`-side fix (either the seed must allocate, or `Release` must
tolerate a missing allocation on cancel) and is out of scope here. What this
repository does about it is not treat an unrecognised failure as a probable
success: a 500 leaves the sales order's status untouched and walks the card
back to Order, with the ERP's own sentence on the timeline. There is a test for
exactly that in `src/core/gable/__tests__/capabilities.test.ts`.

#### Wired for real

| | Endpoint |
|---|---|
| Sign-in, sign-out, session expiry | `POST /login`, `POST /logout` |
| Catalog | `GET /catalog`, `GET /catalog/{id}` |
| Customer-specific pricing | `customer_price` / `price_source` on the catalog DTO |
| Projects | `GET /projects` |
| Order submission | `GET/POST/DELETE /cart[/items]` then `POST /checkout` |
| Order status | `GET /orders`, `GET /orders/{id}`, refined by `GET /deliveries` |
| AR | `GET /dashboard`, `GET /invoices` |
| **Quote desk** | `GET/POST /quotes`, `GET /quotes/{id}`, `POST /quotes/{id}/accept\|decline` |
| **Project on an order** | `project_id` on `PortalOrderDTO` and on `POST /checkout`; `GET /orders?project_id=`; `PUT /orders/{id}/project` |
| **Order cancellation** | `POST /orders/{id}/cancel` |
| **Delivery reschedule *request*** | `POST/GET /deliveries/{id}/reschedule` |
| **Lead time** | `lead_time_days` on the catalog product — nullable, and the null is kept |
| **Volume breaks** | `GET /catalog/{id}/volume-breaks`, plus `volume_breaks` on the detail DTO |
| **Category tree** | `GET /catalog/categories`; `?category_id=` on `GET /catalog` |
| **Change feed** | `GET /orders?since=`, `ETag` / `If-None-Match`, `X-Portal-Latest-Change` |

The simulator's scheduler is **stopped** on the wired path. A real ERP drives
state; a timer aging cards behind a live board is the exact bug that would make
this integration worse than no integration.

#### The eight capabilities, and what each one is actually allowed to claim

This section used to be titled *"Endpoints `gable` does not have"* and listed
eight of them. Seven were closed by `gable`'s headless-portal-core pass and are
now consumed here; the eighth (the push channel) is unchanged. What matters is
not that they are wired but **what each one is permitted to say on screen**, so
that is what is recorded.

1. **Quote desk — wired.** The Quote column sends the order's scope to
   `POST /quotes`. The request carries no price field of any kind, by design on
   both sides: a contractor sends a scope and the dealer prices it. A
   special-order line goes with it — `product_id` null plus a description and a
   unit — which is the first time a custom door has been able to leave this
   browser. `syncQuotes` reads the dealer's prices back and writes them onto
   the lines; accept and decline are real, and a 409 `QUOTE_NOT_PRICED` is
   shown with the dealer's own sentence rather than "Conflict".
   *Refuses rather than guesses:* prices are applied only when the returned
   lines still match this order's scope, verified line by line. A mismatch
   writes nothing, because putting one product's price on another product's
   line is invisible to a contractor and an unpriced order is not.

2. **Project on an order — wired.** Checkout files a new order against its job.
   The customer's *existing* dealer orders are imported per project through
   `GET /orders?project_id=`, so an order placed at the counter lands on the job
   the **dealer** filed it against. An order the dealer filed against no job is
   listed on the project screen as "at your supplier, not on a job yet" and is
   **not** auto-assigned — which job it was for is the contractor's knowledge,
   and guessing would put one site's materials on another's cost. Filing one
   writes through `PUT /orders/{id}/project` first, so the dealer's copy and the
   board agree.

3. **Order cancellation — wired.** Dragging a placed card back to Plan calls
   `POST /orders/{id}/cancel`. All three refusals are honoured with their own
   codes and reasons — `ORDER_ALREADY_CANCELLED`, `ORDER_NOT_CANCELLABLE`
   ("ask the dealer for a credit" is a different instruction from "it is already
   cancelled"), and `ORDER_IN_MOTION`. On a refusal the card goes **back to
   Order** and the sales order's status is untouched.

4. **Delivery reschedule — wired as a REQUEST, and labelled as one.** This is
   the capability most easily rendered as a lie. `gable` answers 202 with
   `applied: false` and deliberately never writes `delivery_routes`; the date on
   the dealer's board does not move. So the button says "Ask to move the
   delivery", the sheet says *this sends a request, not a change*, the
   confirmation says "Requested — nothing has moved until a dispatcher agrees",
   and the board's `promisedDate` is not touched. A test asserts the message
   never contains "moved to".

5. **Lead time — wired, including its null.** `lead_time_days` is nullable and
   the three states are kept apart: `0` is "ships today", a number is that many
   days, and **null is "the dealer has not published one"** — rendered as
   exactly that, never as 0. The lead-time-vs-delivery-date warning goes
   **silent** on an unpublished lead time rather than computing against a guess.
   This also fixed a pre-existing conflation on the portal side: a catalog line
   with no lead time in its snapshot used to default to 0 and read as "In
   stock".

6. **Volume breaks — wired, per product.** `GET /catalog/{id}/volume-breaks` is
   loaded for the products on an order (the order workspace is where the
   "buy more, pay less" decision is made), not speculatively for the whole
   catalog. Until a ladder loads, `nextBreak` is **absent**, which is the honest
   unloaded state; a loaded-but-empty ladder is a different value, and a failed
   load is cached as neither.

7. **Category tree — wired.** `GET /catalog/categories` gives browse the
   dealer's real `product_categories` hierarchy, so clicking "Lumber" cascades
   to the studs filed under Framing Lumber. A product the ERP never linked keeps
   its flat display-string aisle so it stays browsable, and a tree failure
   degrades to the old flat behaviour rather than failing the connect.

8. **Change feed — wired.** The 30-second poll is conditional: the previous
   `ETag` goes out as `If-None-Match` and the previous
   `X-Portal-Latest-Change` as `?since=`. A 304 does **no** work — no store
   writes and no delivery fetch, which was the other half of every wasted poll.
   The cursor is only advanced when the ERP actually sent one.

#### What is still genuinely missing after this work

- **No push channel.** `?since=` + `ETag` makes the poll cheap; it does not make
  it a subscription. Status still arrives up to 30 seconds late.
- **No quote-to-order conversion.** Accepting a quote closes it at the dealer
  and puts their prices on the lines. It does **not** place an order — the order
  still goes through cart + checkout, and a special-order line therefore still
  cannot be *ordered* through the portal even though it can now be *priced*.
  The UI says this next to the Accept button.
- **Withdrawing an unpriced quote.** `gable` only lets a customer decline a
  quote it has priced and SENT, so pulling back a request nobody has looked at
  yet comes back 409. The portal reports that the dealer still has it rather
  than marking it withdrawn.
- **No unit of measure for a cubic yard.** `gable`'s `uom_type` enum has no CY.
  A line measured in one is refused by name rather than relabelled into a unit
  the dealer would price differently.
- **No lead time on a quote line.** The quote DTO carries a price and no date,
  so a desk-priced special-order line has no lead time — absent, not zero.
- **Applying an approved reschedule.** Deliberately out of scope on the `gable`
  side (it is a dispatch-side feature) and therefore out of scope here. The
  request queue is the whole of it.
- **`?category_id=` is implemented in the client and exercised by tests, but
  browse filters locally.** The portal pulls the whole catalog once on connect
  and cascades through the ERP's own tree client-side, which is the same result
  for one round trip fewer. The parameter is there for a paged catalog.
- **No order number.** `PortalOrderDTO` has an id and no human number, so cards
  read `GBL-<first 8>` rather than a number anyone at the yard could look up.

#### Two defects found by wiring it, both fixed here

- **A rejected login was reported as a session expiry** and fired the expiry
  handler, tearing down a session that had never existed. On `/login` a 401 is
  the expected answer to a normal question; everywhere else it is the end of
  one. Caught by the live transcript, not by a test.
- **An ERP status change that the portal rounds to the same state was
  invisible.** `CONFIRMED → ON_HOLD` both map to `confirmed`, so the poll saw
  "no change" and the contractor never learned their order had been held.
  De-duplication now compares what the ERP *said*, not what the portal made of
  it.

#### What is still local, and is labelled in the UI

The pre-quote **Plan** stage, the customer quote's **markup / labour /
overhead**, and the **e-signature**. `gable` has no equivalent endpoints and
inventing them was out of scope. The `LocalOnly` component exists to keep that
disclosure next to the thing it is about rather than buried in this file; the
homeowner's signing screen carries an unconditional version of it, because that
page is reached by an unauthenticated share link and has no ERP connection to
key off.

Those three keep their labels and their labels are unchanged. What *did* change
is the Quote column: it used to carry a "this stays in your browser" disclosure
because nothing was sent anywhere, and it now describes a real dealer desk,
because there is one. A capability that is genuinely wired should stop
apologising for itself; a capability that is not must keep its label. The
`SupplierCapabilities` record on `src/core/supplier/port.ts` is what the UI
branches on, so the two can only disagree by someone setting a flag that is not
true.

#### Still open

`gable` contains a portal-shaped surface of its own at `app/src/pages/portal/`.
Which repository is *the* contractor portal is still undecided. What is now
settled is the seam: `backend/internal/portal/` is the contract, and this
repository is a client of it.

The board is now wired past the spine — quotes, cancellation, reschedule
requests, job history, lead times, volume breaks and the category tree all run
against `gable`. **AR is the part that has not moved.** Invoices, deliveries and
the dashboard are reachable through `src/core/gable/client.ts` and tested, but
the Pay tab still reads the local invoice store rather than `gable`'s, so the
balance a contractor sees there is a seeded number next to a live board. That is
the next honest increment.

### 2. No backend and no database *of the portal's own*

Authentication is no longer on this list — see §1. Wired to `gable`, a
contractor signs in with real credentials against a real JWT middleware, and the
session is an httpOnly cookie this app cannot read. **Standalone, there is still
no login at all**: you open the app and you are Dana Reyes of Summit Ridge
Builders.

Everything below is still true in both modes, because the portal has no
persistence of its own either way.

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

### 3. Brand assets — RESOLVED, recorded so it is not reintroduced

This repository previously shipped nine AI-generated imitations of live
trademarks — Weyerhaeuser, Georgia-Pacific, LP, YellaWood, GAF, Owens Corning,
Trex, Simpson Strong-Tie and Quikrete — wired into `brands.json` alongside each
company's real name, description and website. That is a trademark exposure
independent of copyright: a confusingly similar mark presented as a company's
own, next to their real URL, with nothing telling a visitor it is synthetic.

**It was fixed before the repository was ever pushed**, so the imitations are
not in public git history. Every manufacturer in the demo catalog is now
fictional — Cascade Timber Works, Pinehurst Mills, Northbeam Engineered Wood,
SunGuard Treated Lumber, Meridian Panel Co., Ironclad Fasteners, IronOak
Connectors, ThermaLoft Insulation, SummitLine Roofing, EverDeck Composites and
StoneSet Concrete. Logos are generated SVG wordmarks that carry the line
"Fictional brand — demo data only" in the artwork itself, and every website uses
the RFC 2606 reserved `.example` TLD, which can never resolve.

**Do not reintroduce a real manufacturer's name, mark or URL into the demo
data.** The rest of the fixture is fabricated for the same reason; the brand
layer was the one place it was not.

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

### 6. Two defects found while writing tests — RESOLVED

Both were pinned by `it.fails(...)` tests asserting the *correct* behaviour, so
the fixes turned those tests green rather than rewriting them. The pins are
gone; the tests remain.

- **`breakOpportunity.savesCents` could be negative.** In
  `src/core/selectors/order.ts`, `savesCents` was
  `costNow - (breakUnitPrice × breakMinQty)`. Buying up to a volume break
  normally costs more in total even though the unit price drops, so a field
  named "saves" routinely held a negative number — "you save -$28.00". No UI
  rendered it, which is the only reason it never reached a contractor.
  **Fixed** by splitting the trade into two fields that each match their name:
  `savesCents` is clamped at zero and holds a saving only when the break
  quantity genuinely beats the current total (the same convention
  `orderTotals.savings` already used), and the ordinary case — lower unit
  price, higher bill — is carried by the new `addCostCents`. Exactly one of the
  two is non-zero. The opportunity is still returned either way, because
  "+20 units → $4.28/unit" is worth surfacing even when the total goes up.
- **`reorderInStage()` had no permission gate and reported a `sortOrder` it did
  not persist.** Every other mutation in `src/core/actions/orders.ts` opens with
  `requireCapability(...)`; this one did not, so a Field-role user was refused a
  stage move and allowed a reorder. It also returned
  `{ ...order, sortOrder: newSortOrder }` while writing the post-splice index,
  so an out-of-range argument made the returned object disagree with the store.
  **Fixed**: gated on `edit-scope` like its siblings, and the requested position
  is clamped into the column once and used for both the write and the return
  value. The function still has no callers — board drag-and-drop goes through
  `moveOrderToStage` — but it is exported from the core API surface.

`repriceOrder()` in `src/core/actions/scope.ts` was found to be in the same
class during the follow-up audit — exported, mutating, ungated, zero callers —
and is now gated on `edit-scope` alongside the rest of that file. The simulator
never came through it (the quote desk writes prices via
`stores.patchScopeItem`), so gating it cannot stall the supplier side. Every
other exported mutation under `src/core/actions/` carries a gate; the only
ungated ones left are deliberate and documented in place:
`systemInvoiceOrder` (supplier-driven), `switchActiveMember` (the switcher *is*
the login story in this demo), and the three customer-side quote actions reached
through a share link, where the actor is the homeowner and not a team member.

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
3. **Replace `public/images/brands/`.**

### Next

4. **A server.** Nothing on this list past here is meaningful without one:
   identity, persistence, and an audit trail. This is where the portal stops
   being a prototype.
5. **The first real adapter.** BisTrack has the largest independent footprint,
   so it is the obvious first target — with a design-partner dealer, not
   speculatively.
6. **Web components.** The stated direction is that a dealer's web person drops
   the board into their own site. `src/core/` being framework-free is what makes
   this a rewrite of `src/ui/` rather than of everything, and that boundary is
   already enforced and tested. Nothing else has started.

### Later

7. **Capture as the front door** — camera and voice into priced Plan-stage
   lines, offline-first queueing.
8. **Deposit at signature** — the customer-quote acceptance ceremony already
   freezes scope, price, and consent; taking a deposit at that moment is the
   nearest real money moment.
9. **The price-lock book** — `priceExpiresAt` already exists on every
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
