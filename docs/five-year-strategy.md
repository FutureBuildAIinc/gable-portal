<!--
SPDX-License-Identifier: LicenseRef-OpenLBM-Docs-1.0
SPDX-FileCopyrightText: 2026 FutureBuild, Inc. and OpenLBM contributors
-->
# GableNow: the five-year line

*Synthesized 2026-07-31 from a 12-agent research + strategy panel: three market
researchers (dealer portals, construction AI, contractor–dealer economics), six
independent strategy visions, judged by three hostile personas — a 25-year LBM
dealer executive, a software-hating framer, and a moat-focused investor.*

## Where the market actually is

- **Roofing is ahead of lumber.** Beacon PRO+ runs ~26% digital residential
  sales with measurement-to-order and AR payment; SRS Roof Hub converts
  estimates to orders in one click. Nothing equivalent exists for the framing
  package.
- **Lumber's giants are portal-first.** BFS's myBLDR processed $1B+ in digital
  orders in 2024, targeting $1B *incremental* by 2026 — but it is a destination
  the contractor must adopt. Average independent-dealer ecommerce penetration is
  still **under 1%**.
- **The ERP vendors (ECI Spruce, Epicor BisTrack Web Track, DMSi Agility) ship
  dealer-owned storefronts**; TOOLBX is the closest analogue (AI order
  ingestion, AR) but is portal-first, dealer-side, with no contractor-side
  agent and no homeowner surface.
- **Home Depot now owns SRS + GMS** (1,200+ pro locations) and shipped an AI
  Material List Builder in Pro Xtra (March 2026). The window for independents
  to answer is open but not indefinite.
- **What everyone stops at:** the contractor. Nobody holds the homeowner's
  signed acceptance, nobody carries a contractor identity across dealers, and
  nobody shows promise-vs-actual truth.

## The three scarce assets

The panel's six visions collapsed into one strategy claiming three assets no
competitor can hold simultaneously:

1. **Dealer-funded distribution** — the embed. GableNow is not a destination;
   it appears inside the dealer's existing logged-in site, white-labeled, sold
   by the outside sales rep the contractor already trusts. Dealer ecommerce
   dies at the login screen; the embed never presents one.
2. **The contractor's daily thumb** — capture. The camera, the voice note, and
   the crew's text message become priced Plan-stage lines with zero data entry.
   Whoever holds the thumb at the moment of shortage owns the reorder.
3. **The signed homeowner moment** — money. The `/q/:token` page is the only
   place where a homeowner's "yes" arrives already priced by the dealer's ERP,
   markup applied, signature captured, total frozen. Every money artifact of
   the job (deposit, change order, draw, lien waiver) derives from it.

Everything else the visions claimed — the correction corpus, the delivery-truth
ledger, the forward demand book, portable trade credit — is **exhaust** from
these three, and compounds only after they exist.

## The sequence

**Phase 0 — now (M9).** Deploy target + live model round trip. Then the single
highest-leverage engineering move: **freeze the sim's facade as the published
Adapter Contract** and make the sim's behavioral test suite the certification
harness every real ERP adapter must pass (pricing precedence, cascades, expiry
re-blocking, lifecycle events). The simulator stops being a demo prop and
becomes the conformance suite — an asset TOOLBX and the ERP vendors don't have.

**Phase 1 — the chassis.** First certified adapter (BisTrack has the largest
independent footprint) with one design-partner dealer; the planned Lit
migration ships the board as web components a dealer's web person drops into
their own domain in under a week. The three-layer token system was built for
exactly this; "Order" must look identical across every dealer.

**Phase 2 — the thumb.** Promote capture to the front door: one camera/mic
button where "New order" sits; offline-first queueing (the stores are already
JSON-serializable); the **crew line** — a phone number per job, no accounts, no
seats: a text from the framer's crew lands as proposed lines the GC approves
with one tap. Start logging the **correction corpus** immediately (every
'2x10x16 PT' → SKU fix is a labeled example nobody else can collect).

**Phase 3 — the money moments.**
- **Deposit at the signature** — the same tap that signs pays N% down, on the
  M7 payment rails. Chain of custody: ERP price → markup → frozen scope →
  verbatim consent → funds. No competitor can assemble it.
- **The price-expiry change order** — the LBM-specific killer. The domain
  already treats a lapsed dealer price as unpriced; when the dealer reprices, a
  CO drafts itself as a diff between the two states only GableNow holds: the
  supplier's repricing event and the homeowner's signed baseline. Signed with
  the existing ceremony.
- **The price-lock book** — every `priceExpiresAt` across every job managed as
  one queue: re-quote before lapse, warn when a customer quote outlives its
  supplier horizon. Real money weekly in a market that moved 16% YoY.

**Phase 4 — the compounding exhaust.** Delivery truth ("promised 10 days,
actually 15 at p80") upgrading the existing lead-time chips; markup-elasticity
one-liners under the existing slider ("7 of 10 deck jobs near you accepted
~24%"); the anonymized forward demand book for the dealer's buy desk; portable
trade credit once 5+ dealers overlap. Each gates on volume; none adds a screen.

## The standing guardrails (what keeps it simple)

- **Zero new screens.** Every capability above lands as a card on the board, a
  chip on a line, or an item in the existing approve queue. The board stays the
  only home. If a feature needs a new nav destination, it's the wrong feature.
- **The agent drafts; the thumb approves.** The M8 architecture — every AI
  action through the same guarded, Result-returning action a button calls, with
  commit-tier suspension — is the trust chassis for everything agentic. Ship
  "auto-order" as a day-one toggle and one $12k wrong truckload poisons the
  trade; **earn autonomy per relationship**, each approval recorded like a
  signature, mandates narrow and revocable.
- **Never invent a quantity, never invent a price.** Unchanged from M8. The
  takeoff widget stays a separate product; consumption suggestions come only
  from the contractor's own captured history.
- **The judges' warning:** the framer adopts whatever removes a phone call and
  quits at the first login screen. Every phase is measured against that.

## What to instrument now (cheap, compounds forever)

1. Correction-corpus events in `actions/scope.ts` (parse → edit → confirm).
2. The approval ledger: every commit-tier confirm frozen QuoteAcceptance-style.
3. Promise-vs-actual pairs from the scheduler lifecycle (already emitted; just
   persist them keyed by SKU class).
4. Customer-quote outcome events (accepted / expired / declined, time-to-yes).

All four are pure-core logging the simulator already exercises.
