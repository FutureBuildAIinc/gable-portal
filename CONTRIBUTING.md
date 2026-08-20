<!--
SPDX-License-Identifier: LicenseRef-OpenLBM-Docs-1.0
SPDX-FileCopyrightText: 2026 FutureBuild, Inc. and OpenLBM contributors
-->

# Contributing to Gable Portal

Thanks for being here. This document is the workflow and the standards. If you
are working with Claude Code, read
[CONTRIBUTING-WITH-CLAUDE.md](CONTRIBUTING-WITH-CLAUDE.md) as well — `.claude/`
ships skills and slash commands that automate most of what follows.

Everyone participating agrees to the [Code of Conduct](CODE_OF_CONDUCT.md).
Security problems go to [SECURITY.md](SECURITY.md), never to a public issue.

---

## Before you start

**Read [ROADMAP.md](ROADMAP.md).** It says plainly what is not built. A good
number of reasonable-sounding contributions are blocked on architecture
decisions that have not been made yet — most of all the integration with
[`gable`](https://github.com/FutureBuildAIinc/gable), which does not exist. It
is better to find that out before you write the code.

**Open an issue first for anything non-trivial.** For a typo or an obviously
correct one-line fix, just open the PR.

## Setting up

```bash
git clone https://github.com/FutureBuildAIinc/gable-portal.git
cd gable-portal
npm install
npm run dev          # http://localhost:5173
```

Node ≥ 20.19; CI and the maintainers use 22. There is no database, no
migration, and no required `.env`. The app boots with demo data.

If you are working on the AI assistant you will need an Anthropic API key — see
the README. If you are not, you do not: the assistant is *disabled and looks
disabled* without one, which is itself a tested behaviour.

## The four gates

Run all four before every commit. CI (`.github/workflows/ci.yml`) runs exactly
these, in this order, plus the REUSE licensing gate.

```bash
npm run typecheck    # tsc --noEmit
npm run lint         # biome check .   (NOT --write; this is what CI runs)
npm test             # vitest run
npm run build        # tsc -b && vite build
```

`npm run check` is the writing version of the lint step — run it first, then
`npm run lint` to confirm.

A single test file: `npx vitest run src/core/lib/__tests__/money.test.ts`.
A single test by name: add `-t "keeps the subtotal"`.

### The gates that are not `npm test`

Five more exist. They are not in CI because each boots a real server and drives
it with a real browser, and a flaky browser launch failing an unrelated PR
trains people to ignore CI. Run the relevant ones yourself:

| If you touched | Run |
|---|---|
| `server/`, the admin console, anything that serves a file | `npm run security` **and** `npm run predeploy` |
| Any screen | `npm run a11y`, `npm run e2e` |
| Colours or the theme | `npm run contrast` |
| A flow that the user guide documents | `npm run guide` |

`npm run security` and `npm run predeploy` are twins — the first attacks the
Vite dev server, the second attacks the production host in `server/serve.ts`.
They share almost no implementation, so passing one says nothing about the
other. Building the second one caught a false green in the first.

**`docs/user-guide.md` is part of "done".** If you change a documented flow,
run `npm run guide` (needs a locally installed Chrome) and commit the
regenerated screenshots in the same PR. The harness fails loudly when a screen
it expects is missing, so it doubles as a smoke test.

---

## The rules that are not negotiable

### 1. `src/core/` is framework-free

No React, no `react-dom`, no `react-router`, no `use-sync-external-store`, no
Lit — not in an import, not in a dynamic import, not in a type-only import.
`src/ui/` is the only place that knows a framework exists.

This is enforced by a Biome `noRestrictedImports` override *and* by
`src/core/__tests__/architecture.test.ts`, which walks the tree and fails on a
banned specifier. The test exists because a lint rule can be disabled inline
and a test cannot. **Do not weaken that test to land a change.** If you need
core to reach the DOM, the answer is a hook in `src/ui/hooks/`.

### 2. Money is integer cents, and totals have one definition

- Every amount in this codebase is `Cents` — an integer. Floats appear exactly
  once, in the seed, and `src/core/lib/money.ts` converts them at that
  boundary. Adding a second float boundary is a defect regardless of whether a
  test catches it.
- `orderTotals()` in `src/core/domain/totals.ts` is the *only* place an order
  total is computed. The board card, the order page, the customer quote, and
  the AI all call it. If you find yourself summing line extensions in a
  component, stop — that is how two surfaces come to disagree about the same
  order.
- **An unknown total is not zero.** `hasKnownSubtotal()` exists because an order
  whose lines all await the quote desk sums to `$0.00`, and rendering that
  confidently next to "1 item still needs dealer pricing" is a lie about what
  the order is worth.

**A PR that changes a number needs a test that would have failed on the old
number.** Not a test that exercises the new code — a test that pins the
arithmetic. This is the single thing reviewers will push back on most.

### 3. Every mutation goes through `src/core/actions/`

The board buttons call these functions. The AI's tools call **the same
functions**. That is what makes an assistant action indistinguishable from a
contractor action, and it is why the permission gates cannot be bypassed by
going through the model. Do not add a store write anywhere else.

Actions return `Result<T>` rather than throwing, because a refusal is content:
it is shown to the contractor and handed to the model verbatim. A refusal
sentence should name who *can* do the thing — "Only Robin or Dana can move an
order between stages — you're in as Sam (Field)" — because "not allowed"
teaches nothing.

### 4. Never invent a quantity, never invent a price

The assistant may draft, suggest, and ask. It may not produce a number that did
not come from the pricing engine or from the contractor. A dealer's configured
`houseRules` are **additive** to the system prompt and cannot replace this;
making them able to override it is a security-class change (see
[SECURITY.md](SECURITY.md)).

### 5. No hardcoded dealer name in shipped copy

The demo dealer's name lives in exactly one place —
`DEFAULT_CONFIG` in `src/core/domain/config.ts` — because a dealer deploying
this rebrands it. A test walks every `.ts`/`.tsx` file under `src/` and fails if
the string `Gable` appears in code outside a PascalCase product identifier
(`GableNow`, `GableMark`). Use `supplierName()` from
`src/core/config/runtime.ts`.

---

## Licensing your contribution

Every file needs an SPDX header, or a `.license` sidecar for formats that
cannot carry a comment (`.json`, `.png`). [LICENSE-MAP.md](LICENSE-MAP.md) has
the per-path table; in short, code is
`LicenseRef-OpenLBM-Community-Source-1.0` and prose and repo plumbing are
`LicenseRef-OpenLBM-Docs-1.0`.

```
// SPDX-License-Identifier: LicenseRef-OpenLBM-Community-Source-1.0
// SPDX-FileCopyrightText: 2026 FutureBuild, Inc. and OpenLBM contributors
```

**Comment syntax matters per file type, and getting it wrong breaks the build
rather than the lint:**

| Extension | Syntax |
|---|---|
| `.ts` `.tsx` `.mjs` `.js` | `//` |
| `.css` | `/* ... */` — **never `//`.** PostCSS rejects it and `npm run build` fails outright. |
| `.html` `.svg` `.md` | `<!-- ... -->` |
| `.yml` `.py` `.gitignore` `.env.example` | `#` |
| `.json` `.png` and other binaries | a `<name>.license` sidecar |

`.html` files: the header goes **after** `<!doctype html>`, not before it.

Check your work locally the way CI does:

```bash
pipx install reuse==6.2.0     # or: pip install reuse==6.2.0
reuse lint
python3 .github/scripts/reuse_gate.py
```

> If you run `reuse lint` on an untracked working tree, it will scan
> `node_modules/` and report thousands of findings. That resolves the moment the
> tree is committed, because `reuse` respects `.gitignore` for tracked repos.
> Judge compliance excluding `node_modules/`.

By opening a pull request you confirm you have the right to contribute the work
and you license it under the license governing the files you changed.

---

## Pull requests

**PRs target `staging`.** Maintainers fast-forward `staging → master` after
review.

> **Known drift:** this repository's default branch is currently `main`, and
> neither `staging` nor `master` exists yet. Until they are cut, branch from
> `main` and open your PR against `main`. `.github/workflows/ci.yml` already
> triggers on all four names so nothing has to change when they appear. This is
> tracked in [ROADMAP.md](ROADMAP.md).

1. Branch from the default branch.
2. Make the change. Keep the diff to one concern.
3. Run the four gates, plus whichever of the five extras your change touches.
4. Push and open the PR. The template
   ([`.github/PULL_REQUEST_TEMPLATE.md`](.github/PULL_REQUEST_TEMPLATE.md))
   asks a specific set of questions if your change touches money — answer them.
5. `.github/CODEOWNERS` routes review. Money paths, the credential surface, and
   anything under `LICENSES/` require a maintainer.

### What makes a PR easy to merge

- **One concern.** A formatting sweep bundled with a behaviour change costs a
  reviewer far more than two PRs would.
- **The commit messages explain *why*.** This repository's history is unusually
  good at that — read `git log` for the house style. "Fix bug" tells a future
  reader nothing; "A 'daily' cap meant the UTC day here too" tells them
  everything.
- **A test that pins the behaviour.** Not a test that calls the function — a
  test that would go red if someone re-broke it. Tautological assertions
  (`expect(fn()).toBe(fn())`) will be asked for.
- **Comments explain the reasoning, not the syntax.** Where a line exists
  because something went wrong once, say so. Several of the sharpest comments in
  `src/core/` are of the form "this shipped once" — those are the most valuable
  lines in the file.

### Writing tests

- Tests live next to what they test, in a `__tests__/` directory.
- `*.test.ts` runs in the `core` project (Node, no DOM). `*.test.tsx` and
  `*.dom.test.ts` run in the `ui` project (jsdom). If a core module genuinely
  needs a browser API — storage events, `matchMedia` — name it `.dom.test.ts`
  so it stays out of the DOM-free project.
- **Prioritise money, quantities, and order submission.** This is a B2B
  ordering surface. A formatting bug in a total is a commercial bug.
- If you find a real defect while writing a test, do not silently work around
  it. Write the test that asserts the *correct* behaviour, mark it
  `it.fails(...)` with a comment explaining what is wrong, and say so in the PR.
  A red-but-documented test is worth more than a green one that encodes a bug.

## Reporting bugs and requesting features

Use the templates in [`.github/ISSUE_TEMPLATE/`](.github/ISSUE_TEMPLATE/).
For a money bug, the exact figures you saw matter more than a screenshot.

Route it to the right repository:

| The problem is in | File it against |
|---|---|
| The contractor board, the order/quote/pay screens, the assistant, the admin console | this repo |
| The core ERP, the shared API, or a shared screen | [`gable`](https://github.com/FutureBuildAIinc/gable) |
| Load management, dispatch, routing | [`gable-ai-lm`](https://github.com/FutureBuildAIinc/gable-ai-lm) |
| Architecture or reference documentation | [`gable-docs`](https://github.com/FutureBuildAIinc/gable-docs) |
| The licensing Standard itself | [`openlbm`](https://github.com/FutureBuildAIinc/openlbm) |
| Anything with a security impact | **[SECURITY.md](SECURITY.md)**, privately |
