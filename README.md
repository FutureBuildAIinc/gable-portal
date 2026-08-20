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
> **This is a working prototype, not a shipping product.** It is an unusually
> well-built prototype — 451 tests, a strict TypeScript build, five out-of-band
> browser-driven audit gates, and a domain layer with real invariants — but the
> boundary is sharp and worth stating plainly:
>
> - **There is no server-side application and no database.** All state lives in
>   the browser's `localStorage`. Close your browser profile and the data is
>   gone. Two people cannot share a board.
> - **There is no authentication.** You open the app and you are Dana Reyes of
>   Summit Ridge Builders. The team switcher changes which *role* you act as, so
>   the permission gates are real code paths, but nobody logs in.
> - **There is no ERP behind it.** `src/core/sim/` is a simulator that plays the
>   supplier: it prices lines, runs a quote desk, ages orders through a
>   lifecycle, and issues invoices. Pricing is real logic against real rules —
>   the *counterparty* is fictional.
> - **The dealer is fictional.** "Gable Supply" is a default in
>   `src/core/domain/config.ts`; the demo contractor is "Summit Ridge Builders".
>   No real dealer's or customer's data is in this repository.
>
> [ROADMAP.md](ROADMAP.md) lists what is not built, without softening it.

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
window into it. Today those are two separate stories: the portal talks to a
simulator, not to `gable`. **No integration between this repository and `gable`
exists yet** — not a client, not an adapter, not an API contract. That is the
single largest gap and it is the top item in [ROADMAP.md](ROADMAP.md).

`gable` already contains portal-shaped surfaces of its own under
`app/src/pages/portal/` and `backend/internal/portal/`. Reconciling those with
this repository — which is the portal, and which is the seam — is an open
architectural question, not a settled one.

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
| `npm run serve` | Run that bundle (`PORT`, `HOST` configurable; `HOST` defaults to `127.0.0.1`) |

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
  sim/               the supplier's ERP: pricing engine, quote desk, lifecycle
  actions/           the ONLY mutation path — buttons and the AI both call these
  selectors/         read models (board, order detail, AR, tracking)
  stores/            tiny observable stores + localStorage with cross-tab leases
  ai/                prompt, session, and the tool layer bound to actions/
src/ui/            React 18, Tailwind 4, react-router
src/admin/         the dealer console — a separate Vite entry point
server/            host-agnostic (req, res) handlers: Claude proxy + admin API
scripts/           the five out-of-band audit gates + the guide capture harness
```

`CLAUDE.md` is the long-form architecture document — roughly a thousand lines
of why, written as the milestones landed. It is the best thing to read before
changing anything in `src/core/`.

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
