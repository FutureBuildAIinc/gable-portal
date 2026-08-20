---
name: Feature request
about: Propose a capability the portal does not have yet
title: ""
labels: enhancement
assignees: ""
---

<!--
SPDX-License-Identifier: LicenseRef-OpenLBM-Docs-1.0
SPDX-FileCopyrightText: 2026 FutureBuild, Inc. and OpenLBM contributors

READ ROADMAP.md FIRST. It lists, plainly, what is not built yet — including
things that look built (there is no real ERP behind this; `src/core/sim/` is a
simulator) and things that are deliberately out of scope. If your request is
already there, add a comment to the existing discussion instead of opening a
new issue.
-->

## The job to be done

<!-- Describe the contractor's or dealer's situation, not the UI you imagine.
     "I need to know before I leave the yard whether the LVL will be there
     Thursday" is more useful than "add a column to the board". -->

## Who has this problem

- [ ] A contractor placing orders
- [ ] A contractor's office / back-office staff
- [ ] A dealer configuring the portal (admin console)
- [ ] A dealer's inside sales / quote desk
- [ ] A homeowner receiving a customer quote
- [ ] Someone else:

## What you do today instead

<!-- The workaround, including the phone calls. -->

## Does this need a new screen?

The project has a standing guardrail (`docs/five-year-strategy.md`): **zero new
screens.** New capability should land as a card on the board, a chip on a line,
or an item in an existing queue. If your proposal needs a new navigation
destination, say why the board cannot hold it — that is not a rejection, it is
the conversation worth having up front.

- [ ] It fits on the existing board / order / quote surfaces.
- [ ] It needs a new destination, because:

## Does it touch money?

- [ ] No.
- [ ] Yes — it changes a price, a quantity, a total, or what a contractor or
      homeowner is committed to. If so, describe the arithmetic precisely.
      Two rules are non-negotiable and predate this issue: **never invent a
      quantity, never invent a price.**

## Anything else

<!-- Links to how another portal solves it, screenshots, a sketch. -->
