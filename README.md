<!--
SPDX-License-Identifier: LicenseRef-OpenLBM-Docs-1.0
SPDX-FileCopyrightText: 2026 FutureBuild, Inc. and OpenLBM contributors
-->

# Gable Portal — GableNow

**An AI-native procurement portal for contractors buying from LBM (lumber &
building materials) suppliers.** Plan → Quote → Order → Invoice, on one board.

[![License: OpenLBM Community Source 1.0](https://img.shields.io/badge/license-OpenLBM%20Community%20Source%201.0-blue)](LICENSE)
[![Docs: OpenLBM Docs 1.0](https://img.shields.io/badge/docs-OpenLBM%20Docs%201.0-lightgrey)](LICENSES/LicenseRef-OpenLBM-Docs-1.0.txt)
[![REUSE compliant](https://img.shields.io/badge/REUSE-compliant-green)](REUSE.toml)

> ### Read this before you read anything else
>
> **This runs in two modes, and which one you are in changes what every number
> on screen means.** The app says which, on every screen, in the badge under the
> dealer's name.
>
> **Wired (`GABLE_API_URL` set).** The portal talks to a real
> [`gable`](https://github.com/FutureBuildAIinc/gable) ERP. Contractors sign in
> with real credentials, browse the dealer's real catalog at their own
> account pricing, and place orders that land in the dealer's `orders` table.
> Order status is read back from the ERP. See
> [Wiring it to `gable`](#wiring-it-to-gable).
>
> **Standalone (`GABLE_API_URL` unset — the default).** `src/core/sim/` is a
> simulator that plays the supplier: it prices lines, runs a quote desk, ages
> orders through a lifecycle, and issues invoices. Pricing is real logic against
> real rules — the *counterparty* is fictional. Every screen is labelled "Local
> simulation". **Do not put a standalone deployment in front of real
> contractors: the prices are invented.**
>
> Either way, these remain true:
>
> - **The portal has no database of its own.** Board state — projects, drafts,
>   scope, customer quotes, signatures — lives in the browser's `localStorage`.
>   Close your browser profile and it is gone. Two people cannot share a board.
>   Wired, the things that matter (catalog, pricing, orders, status) live in
>   `gable`; the board around them does not.
> - **Three things are portal-local by design, even when wired,** because
>   `gable` has no endpoint for them: the pre-quote **Plan** stage, the
>   **customer-quote markup / labour / overhead**, and the **e-signature**. The
>   UI labels each one where it appears. A signed customer quote is a
>   `localStorage` record and would not survive a dispute.
> - **The dealer is fictional in standalone.** "Gable Supply" is a default in
>   `src/core/domain/config.ts`; the demo contractor is "Summit Ridge Builders".
>   No real dealer's or customer's data is in this repository. Wired, the dealer
>   name comes from `gable`'s own `PortalConfig`.
>
> [ROADMAP.md](ROADMAP.md) lists what is not built, without softening it —
> including every `gable` endpoint this portal needed and did not find.

---

## Names

Three names refer to the same thing, and all three are in use:

| Name | What it is |
|---|---|
| **`gable-portal`** | This repository, and the npm package name. The ecosystem's name for the product line. |
| **GableNow** | The product's own brand — what the UI says, what `GableMark.tsx` renders, and the prefix on its environment variables (`GABLENOW_ADMIN_TOKEN`). |
| **LumberNow** | The former name. The project was renamed before this migration; the old repository was `futurebuildai/lumbernow`. You will still see it in ecosystem planning documents. |

They were not consolidated because the brand and the repository slug are
answering different questions. This table exists so nobody has to guess.

---

## What it actually does

The premise: contractors abandon dealer e-commerce because it is a retail
shopping cart wearing a trade-account badge. So there is no catalog-first
funnel and no cart. There is a **Procurement Board**.

A **project** is the site — "Wilson Custom Home". It has an address, a client,
and no stage. An **order** is a procurement unit inside it — "Framing package",
"Roofing", "Trim" — with one delivery date, one fulfillment method, and its own
stage. **Orders are the cards**, which is why every card has exactly one
unambiguous position on the board.

| Stage | What happens |
|---|---|
| **Plan** | Draft orders. Lines are priced live by the contractor's account terms — tier baseline, negotiated category discounts, locked contract SKUs, volume breaks. |
| **Quote** | Push to the dealer's quote desk. Required when the scope contains a special-order line the ERP cannot price. Then optionally build a *contractor-branded* customer quote — markup, labor, overhead — shared with the homeowner over a one-time link they can review and sign. |
| **Order** | Converts to a supplier sales order. Delivery or will-call tracking, reschedules, lead times. |
| **Invoice** | AR, including offline counter-sale invoices. Saved payment methods, few-click payment. |

Alongside that:

- **An AI assistant** (`src/core/ai/`) that drafts orders from natural language
  and photographs. It calls **the same guarded action functions the buttons
  call**, so an action the model takes is indistinguishable from one the
  contractor took and cannot bypass a permission gate. Two rules are enforced
  in the system prompt and in the tool layer: never invent a quantity, never
  invent a price.
- **A dealer admin console** at `/admin.html` — branding, terms, feature flags,
  and the Anthropic credential. It is a separate bundle so admin code never
  reaches the contractor bundle.
- **A team and permission model** — owner, purchaser, field, A/P — where a
  refusal names who *can* do the thing rather than just saying no.

The full walkthrough, with 31 captured screenshots, is
**[docs/user-guide.md](docs/user-guide.md)**.

---

## How this relates to `gable`

The Gable ecosystem is a set of repositories under
[`FutureBuildAIinc`](https://github.com/FutureBuildAIinc):

| Repo | Role | License |
|---|---|---|
| [`gable`](https://github.com/FutureBuildAIinc/gable) | The host — the LBM ERP commons that dealers run | Commons / Surface / Connector / Docs |
| [`gable-sdk`](https://github.com/FutureBuildAIinc/gable-sdk) | The plug-in seam for third-party apps | Connector |
| [`gable-ai-lm`](https://github.com/FutureBuildAIinc/gable-ai-lm) | Load-management satellite (dispatch, routing, compliance) | Community Source |
| **`gable-portal`** (this repo) | **Contractor-facing satellite — the buy side** | **Community Source** |
| [`openlbm`](https://github.com/FutureBuildAIinc/openlbm) | The licensing Standard itself | — |
| [`gable-docs`](https://github.com/FutureBuildAIinc/gable-docs) | Architecture and reference documentation | Docs |

`gable` is the **dealer's** system of record. This portal is the **contractor's**
window into it, and as of this change the window is real: set `GABLE_API_URL`
and the spine — auth, catalog, pricing, order submission, order status — runs
against `gable`'s `/api/portal/v1/*` API. See below for exactly what is wired
and what is not.

`gable` also contains a portal-shaped surface of its own under
`app/src/pages/portal/`. Which repository is *the* contractor portal remains an
open architectural question; what is now settled is the seam between them —
`backend/internal/portal/` is the contract, and this repository is a client of
it.

---

## Wiring it to `gable`

```bash
# 1. gable, on :8080, against its own database
cd ../gable/backend
DATABASE_URL="postgres://gable_user@127.0.0.1:5432/gable_db?sslmode=disable" \
  PORTAL_JWT_SECRET="$(openssl rand -hex 32)" \
  INSECURE_COOKIES=true PORT=8080 go run ./cmd/server

# 2. the portal, pointed at it
cd ../../gable-portal
GABLE_API_URL=http://127.0.0.1:8080 GABLE_ALLOW_INSECURE_COOKIES=true npm run dev
```

Sign in with a `customer_users` row from `gable` (the seeded demo is
`demo@kelbrook.ca` / `password`). The badge under the dealer's name turns green
and reads **Live — <dealer>**.

### What is genuinely wired

| | Source of truth | How |
|---|---|---|
| **Sign-in** | `gable` | `POST /api/portal/v1/login`. The JWT is an httpOnly `portal_token` cookie the browser holds and this app cannot read. A 401 signs you out; it is never retried. |
| **Catalog** | `gable` | `GET /catalog` replaces the seeded catalog wholesale. |
| **Pricing** | `gable` | `customer_price` from the ERP's own waterfall (contract → promotional → tier → retail). No tier table on this side. |
| **Projects** | `gable` | `GET /projects` replaces the seeded projects. |
| **Order submission** | `gable` | The board's Plan → Order drag clears the ERP cart, adds this order's lines, and checks out. A real `orders` row appears in the dealer's database. |
| **Order status** | `gable` | A **conditional** poll of `GET /orders` with `ETag` / `If-None-Match` and an `X-Portal-Latest-Change` cursor, refined by `GET /deliveries` only when something moved. **The simulator's scheduler is stopped** — a real ERP drives state, not a timer. |
| **The quote desk** | `gable` | The Quote column sends the scope to `POST /quotes` — including special-order lines the catalog cannot express. A person at the dealer prices it; the price is read back and written onto the lines. Accept/decline are `POST /quotes/{id}/accept\|decline`. |
| **Cancelling a placed order** | `gable` | `POST /orders/{id}/cancel`. A refusal (already cancelled, fulfilled, goods on a dispatched route) puts the card back in Order and shows the dealer's own reason. |
| **Rescheduling a delivery** | `gable` | `POST /deliveries/{id}/reschedule` — a **request**, not a write. It answers 202 with `applied: false` and the dealer's schedule is untouched; the UI says "requested" and never "moved". |
| **Job history** | `gable` | `project_id` on the order plus `GET /orders?project_id=` lands the customer's *existing* dealer orders on the job the dealer filed them against. Orders with no job are listed, not guessed at; `PUT /orders/{id}/project` files one. |
| **Lead time, volume breaks, aisles** | `gable` | `lead_time_days` (nullable — see below), `GET /catalog/{id}/volume-breaks`, and `GET /catalog/categories`. |
| **Invoices, deliveries, dashboard** | `gable` | Available through the client (`src/core/gable/client.ts`); the board reads status and deliveries today. |

A **null** `lead_time_days` means the dealer has published none. It is not
folded into `0` and not replaced with a guess: the product reads "no lead time
published" and the lead-time-vs-delivery-date warning stays silent, because a
crew gets booked around that number.

### What is still portal-local, and is labelled as such in the UI

| | Why |
|---|---|
| **The Plan stage** | A draft scope is the contractor's working notebook. The dealer never sees it, and `gable` has no draft resource. |
| **Customer quote — markup, labour, overhead** | This is the contractor's own margin. The dealer must never see it, and `gable` has no endpoint that would carry it. |
| **E-signature** | A `localStorage` record. It would not survive a dispute. Stated on the homeowner's own screen, not only in the contractor's. |

Those three, and what genuinely remains missing on the `gable` side, are listed
in [ROADMAP.md §1](ROADMAP.md).

### How the connection is shaped, and why

`gable` sets its session cookie `HttpOnly; Secure; SameSite=Strict;
Path=/api/portal`. A `SameSite=Strict` cookie is only ever sent on *same-site*
requests — so a portal on `portal.example.com` calling `erp.example.com`
directly would have the cookie withheld on every request and see 401 forever,
a failure that looks exactly like a wrong password.

So the portal's own host proxies `/api/portal/*` to `GABLE_API_URL`
(`server/gable-proxy.ts`). Everything is same-origin, the cookie's path matches
unchanged, and — the part that matters for deployment — **`GABLE_API_URL` never
reaches the browser and is never baked into the bundle.** It is read at run
time. The client is told only *that* an ERP is configured, via a flag injected
into the document before first paint (so there is no frame in which a simulated
board is shown as a live one).

---

## Running it

Requires **Node ≥ 20.19** (CI and the maintainers use **22**) and npm.

```bash
git clone https://github.com/FutureBuildAIinc/gable-portal.git
cd gable-portal
npm install
npm run dev          # http://localhost:5173
```

That is genuinely all of it. There is no database to provision, no migration to
run, no `.env` required, and nothing to log into — the app boots with demo data
already in place: four projects, eight orders across all four stages, and a
catalog priced through the same engine the live app uses.

**To enable the AI assistant** you need an Anthropic API key. Without one the
assistant is *disabled and looks disabled* — it is not faked. Two ways, and the
choice matters:

```bash
cp .env.example .env
# then set ANTHROPIC_API_KEY=sk-ant-...
```

or paste a key into the dealer admin console at `/admin.html`, which stores it
server-side in `.gablenow/secrets.json` (mode `0600`, gitignored, never returned
to a client). The admin console requires `GABLENOW_ADMIN_TOKEN` to be set and
**refuses every request when it is absent** — there is no open-by-default mode.
Generate one with `openssl rand -hex 32`.

`ANTHROPIC_API_KEY` is deliberately *not* `VITE_`-prefixed, so Vite never inlines
it into the client bundle. It is read in `vite.config.ts` and handed to the
same-origin proxy in `server/claude-proxy.ts`.

### Commands

Every one of these is real; run `npm run <name>`.

| Command | What it does |
|---|---|
| `npm run dev` | Vite dev server |
| `npm run build` | `tsc -b && vite build` — the pre-flight check |
| `npm run typecheck` | `tsc --noEmit` |
| `npm test` | Vitest, once |
| `npm run test:watch` | Vitest, watching |
| `npm run test:coverage` | Vitest with a v8 coverage report in `coverage/` |
| `npm run check` | Biome format + lint, **writing fixes** |
| `npm run lint` | Biome check, **not** writing — this is what CI runs |
| `npm run preview` | Serve the production build with Vite |
| `npm run build:server` | esbuild-bundle the production host to `dist-server/serve.mjs` |
| `npm run serve` | Run that bundle. `HOST` defaults to **`0.0.0.0`** so a container actually receives traffic — set `HOST=127.0.0.1` for a local-only run. |

Four of those — `typecheck`, `lint`, `test`, `build` — are the gates CI enforces
and the gates a PR must pass. Five more exist and are *not* in CI, because each
boots a real server and drives it with a real browser:

| Command | What it catches |
|---|---|
| `npm run a11y` | axe over every screen, both apps, at phone width |
| `npm run security` | boots a real dev server and attacks it |
| `npm run predeploy` | the same, against the production host in `server/serve.ts` — which shares almost no implementation with the dev server, so a defence proven for one says nothing about the other |
| `npm run e2e` | drives the product as a contractor against a production build; fails on any uncaught error or 404 |
| `npm run contrast` | measures rendered contrast ratios |
| `npm run guide` | rebuilds, walks the app with Chrome, and rewrites every screenshot in `docs/user-guide.md` |

Run them before a release. `npm run guide` needs a locally installed Chrome;
the rest use Playwright.

---

## Architecture, in one rule

> **`src/core/` is framework-free.**

All domain logic, pricing, totals, the stage machine, the stores, and the AI
tool layer are plain TypeScript with no React import anywhere. `src/ui/` is the
only place that knows a framework exists. This is enforced three ways: a Biome
`noRestrictedImports` override, a test
(`src/core/__tests__/architecture.test.ts`) that walks the tree and fails on a
banned import, and the fact that `server/` imports from `src/core/` directly.

It exists so the React layer is replaceable — the planned direction is web
components a dealer can drop into their own site — without rewriting the part
that knows what an order costs.

```
src/core/          framework-free
  lib/money.ts       integer cents, everywhere. Never floats.
  domain/            Project, Order, ScopeItem, totals, the stage machine
  supplier/          THE SEAM. port.ts is the interface; sim.ts is one impl.
  sim/               the SIMULATED supplier: pricing engine, quote desk, lifecycle
  gable/             the REAL supplier: HTTP client, schema, mapper, pricing,
                     connection lifecycle. The other impl of supplier/port.ts.
  actions/           the ONLY mutation path — buttons and the AI both call these
  selectors/         read models (board, order detail, AR, tracking)
  stores/            tiny observable stores + localStorage with cross-tab leases
  ai/                prompt, session, and the tool layer bound to actions/
src/ui/            React 18, Tailwind 4, react-router
src/admin/         the dealer console — a separate Vite entry point
server/            host-agnostic (req, res) handlers: Claude proxy, admin API,
                   and the same-origin gable proxy
scripts/           the five out-of-band audit gates + the guide capture harness
Dockerfile         multi-stage: vite + esbuild build, then a node:22-alpine host
.do/               an example DigitalOcean App Platform spec
```

`src/core/supplier/port.ts` is the load-bearing addition. `sim/pricing.ts` has
carried a comment since M1 saying that when a real ERP connects, the simulator
is replaced by an API call returning the same `PriceQuote` and nothing in
`domain/` changes. That is now a tested claim rather than a design intention:
two implementations satisfy one interface, `actions/` calls neither directly,
and the 451 pre-existing tests pass unchanged through the new call frame.

`CLAUDE.md` is the long-form architecture document — roughly a thousand lines
of why, written as the milestones landed. It is the best thing to read before
changing anything in `src/core/`.

---

## Deploying

```bash
docker build -t gable-portal .
docker run -p 8080:8080 -e GABLE_API_URL=https://erp.example.com gable-portal
```

`.do/app-portal.yaml` is an example DigitalOcean App Platform spec, modelled on
`gable/.do/app-demo.yaml`. Replace the repo, the domain and `GABLE_API_URL`
before applying. **It has not been applied to a live account** — the routing,
health-check and env-scope choices in it are reasoned, not observed.

Three things about the container are worth knowing before you debug it at 2am:

- **It binds `0.0.0.0`.** `server/serve.ts` used to default `HOST` to
  `127.0.0.1`, which is correct on a laptop and fatal in a container: App
  Platform's router and health checker live outside the container's network
  namespace, so a loopback bind starts cleanly, logs cheerfully, passes every
  local smoke test, and receives no traffic at all.
- **`preserve_path_prefix: true` is required** on the route. Without it App
  Platform strips the matched prefix and `/api/portal/v1/catalog` reaches the
  container as `/v1/catalog`; the proxy then forwards a truncated path and
  `gable` 404s every call, with nothing in either log saying why.
- **`/healthz` does not touch the ERP.** A `gable` outage must not also take the
  portal out of rotation — the contractor should keep the board and an honest
  "Supplier unreachable" badge, not a 503 from the router.

Nothing is baked in at build time. There is no `ARG` for `GABLE_API_URL` and
nothing `VITE_`-prefixed anywhere, so the same image is promotable from staging
to production and contains no secret and no ERP address.

`GABLE_ALLOW_INSECURE_COOKIES=true` strips `Secure` from the session cookie on
its way back through the proxy. It is needed only when the *portal* is served
over plain HTTP — `npm run dev`, or a container smoke-tested before a TLS
terminator is in front of it. Never set it on anything reachable over a network.

---

## Money

This is a B2B ordering surface, so a formatting bug is a commercial bug. Three
rules the codebase does not bend on:

1. **All money is integer cents.** `src/core/lib/money.ts` is the only boundary,
   and it converts via the decimal string (`Number(\`${dollars}e2\`)`) rather
   than `dollars * 100`, because binary floating point turns `1.005 * 100` into
   `100.49999999999999` and rounds a half-cent the wrong way.
2. **One definition of every total.** `orderTotals()` in
   `src/core/domain/totals.ts` is what the board card, the order page, the
   customer quote and the AI all read, so a total cannot disagree with itself
   between two surfaces.
3. **An unknown total is not zero.** An order whose lines are all awaiting the
   quote desk sums to `$0.00`, and rendering that confidently next to "1 item
   still needs dealer pricing" is a lie about what the order is worth.
   `hasKnownSubtotal()` exists to make the UI show "—" instead.

---

## Licensing

**Code is [`LicenseRef-OpenLBM-Community-Source-1.0`](LICENSE). Prose and repo
plumbing are [`LicenseRef-OpenLBM-Docs-1.0`](LICENSES/LicenseRef-OpenLBM-Docs-1.0.txt).**

Community Source is **source-available, not OSI open source**. Read it, modify
it, build it, evaluate it, redistribute it — everyone, always. Run it in
production free and immediately if you are a **Community Member**: fewer than
50 locations, not controlled by an entity above $1B revenue. That is most
independent dealers and effectively every contractor. Large chains, national
buying groups, and anyone reselling it as a hosted service need a commercial
license. Each released version converts to AGPL-3.0-only five years after its
own Change Date.

[LICENSE-MAP.md](LICENSE-MAP.md) has the per-path table, the reasoning, and the
one thing you should know about `public/images/brands/` before you redistribute
this. The license texts are **drafts pending counsel**; the canonical Standard
is [`openlbm`](https://github.com/FutureBuildAIinc/openlbm).

The trademark grant is **none**. A fork must be renamed.

---

## Contributing

[CONTRIBUTING.md](CONTRIBUTING.md) has the workflow, the gates, and what a good
PR looks like. [CONTRIBUTING-WITH-CLAUDE.md](CONTRIBUTING-WITH-CLAUDE.md) is the
same ground for people working with Claude Code, and `.claude/` ships skills and
slash commands (`/preflight`, `/license-of`, `/file-issue`, `/fix-doc`) that
automate the tedious parts.

Security problems go to **<colton@futurebuild.ai>** or a private GitHub Security
Advisory — **never** a public issue. See [SECURITY.md](SECURITY.md).

Everyone participating agrees to the [Code of Conduct](CODE_OF_CONDUCT.md).
