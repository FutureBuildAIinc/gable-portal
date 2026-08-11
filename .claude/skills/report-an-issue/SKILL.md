---
# SPDX-License-Identifier: LicenseRef-OpenLBM-Docs-1.0
# SPDX-FileCopyrightText: 2026 FutureBuild, Inc. and OpenLBM contributors
name: report-an-issue
description: Turn "something is broken in Gable Portal (LumberNow)" into a properly scoped bug report or feature request, routed to the right repository. Use when the user says "I found a bug", "this screen is wrong", "the total is off", "this doesn't work", "file an issue", "report a problem", "how do I report this", "/file-issue", or describes any behaviour that surprised them.
---

# report-an-issue — from "that looks wrong" to a filed, actionable issue

You are helping someone report a problem. **They may not be a programmer** — a contractor, a
counter person, an estimator, a dispatcher. Do the technical work *for* them.

---

## 0 · Stop: is this a security problem?

**Check this first.** If the report involves any of the following, it does **not** go in a
public issue:

- Seeing data belonging to another customer, branch, or user
- Reaching a page or an action without logging in, or with the wrong role
- A password, API key, token, or credential appearing anywhere
- Changing money, invoices, or payments in a way that looks unauthorised
- An internet-reachable instance where nobody is asked to log in

Route it privately: check `ls SECURITY.md` here and in `FutureBuildAIinc/gable`, then use the
repository's **Security** tab → **Report a vulnerability**, or email
**security@futurebuild.ai**.

> **The exception people trip over:** the Gable demo and staging deployments run with
> `AUTH_MODE=dev`, which intentionally disables login and treats everyone as a seeded admin.
> On those hosts, with fake data, that is expected. It is only a security issue on some *other*
> reachable host.

## 1 · Where does this issue belong?

This repository holds **the contractor / B2B customer portal — the surface a builder or contractor uses to browse the catalogue, price a job, place and track orders, view invoices and AR, and manage their team**.

Right now it is a scaffold — the portal surfaces already in `FutureBuildAIinc/gable` under `app/src/pages/portal/` and `backend/internal/portal/`, plus the LumberNow procurement-board and AI-ordering prototype is where the behaviour actually lives today. So the
first job is routing:

```bash
ls -a          # what is actually in this repo yet?
```

| What they hit | Where it goes |
|---|---|
| Behaviour in code that lives **here** | This repo |
| Behaviour in the core ERP, the shared API, or a shared screen | `FutureBuildAIinc/gable` |
| A documentation problem | `FutureBuildAIinc/gable-docs` |
| A licence text contradiction or an eligibility question | `FutureBuildAIinc/openlbm` |
| A logo, asset, or mark-usage problem | `FutureBuildAIinc/brand` |
| A problem in the plug-in seam / Module SDK | `FutureBuildAIinc/gable-sdk` |

**If this repo has no code yet, say so plainly** and help them file in the right place instead
of opening an issue nobody can act on. The `gable` repo's kit has a `report-an-issue` skill with
a known-landmines checklist that will make the report much better.

## 2 · Get the story in their words

Write down verbatim: what screen, what they did, what they expected, what actually happened,
and whether it happens every time. Do not editorialise — your theory about the cause goes in a
separate section, clearly marked as a guess.

## 3 · Check it against the known landmines

- **Portal money is dollars, not cents.** The ERP API returns `int64` cents; the portal API returns `float64` dollars — sometimes on the same underlying column. Mixing the two renders `$738.87` as `$73,887.00`. See the money table in the `gable` repo's `CLAUDE.md`.
- **Portal auth is separate from ERP auth.** The portal has its own JWT path, and under `AUTH_MODE=dev` it is bypassed and injects demo customer claims. Never rely on that in a design.
- **Parts of `/api/portal/v1/*` are public** by design (login, config). Anything added there needs deliberate thought about what an unauthenticated caller can see.
- **AR balance is derived, not read.** Compute it live from open invoices rather than trusting the denormalised `customers.balance_due` column.
- **Demo data resets.** The seed truncates all transactional data on every demo/staging deploy.
  Orders created on demo yesterday are *supposed* to be gone. Reference data is upserted and
  survives.
- **Is it already reported?** Search open and closed issues, and say what you searched for.

## 4 · Capture the environment

Run these and paste the real output — don't make them guess:

```bash
git rev-parse --short HEAD && git rev-parse --abbrev-ref HEAD
go version 2>/dev/null; node -v 2>/dev/null
```

Plus, where relevant: server logs, the browser console (F12), the Network tab entry for the
failing request, and a screenshot.

**Redact before pasting.** Strip anything key-shaped, and any real customer name or address.

## 5 · Write it

Check for a template first (`ls .github/ISSUE_TEMPLATE/`). If there isn't one yet, use the
shape the `gable` repo uses:

```markdown
## Description
One clear sentence.

## Affected area
The directory or component. If it belongs in another repo, say which.

## Steps to reproduce
1. …  (start from a known state, and name the specific record used)

## Expected behavior
## Actual behavior
Exact numbers, exact error text.

## Environment
Branch / commit SHA, language versions, how it is running, `AUTH_MODE` value.

## Logs, screenshots, or reproduction
Redact secrets and customer data first.

## Additional context
What you ruled out, and — labelled as a hypothesis — where you think it lives.
```

**Title:** what is wrong and where, in one line. Not "portal broken".

If it's really a **feature request** and they're describing how their business actually works,
stop and use the **`describe-a-workflow`** skill instead — it produces a far more useful
artefact.

---

## Ground rules

- **Security bugs never go in public issues.** §0 is not optional.
- **Route to the right repo.** An issue filed against an empty scaffold helps nobody.
- **Never paste a secret, key, or real customer data.**
- **Don't assert a root cause you haven't checked.** Label guesses as guesses.
- **Search for duplicates first.**
