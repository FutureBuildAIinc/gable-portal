<!--
SPDX-License-Identifier: LicenseRef-OpenLBM-Docs-1.0
SPDX-FileCopyrightText: 2026 FutureBuild, Inc. and OpenLBM contributors
-->

# Contributing to Gable Portal with Claude Code

> ## Read this first: there is no code here yet
>
> This repository is an **empty scaffold**. Apart from the `.claude/` kit and `LICENSES/`, it
> contains nothing. The portal surfaces that exist today live in
> [`FutureBuildAIinc/gable`](https://github.com/FutureBuildAIinc/gable) under
> `app/src/pages/portal/` and `backend/internal/portal/`, alongside the LumberNow
> procurement-board and AI-ordering prototype. **That is where the behaviour actually is, and
> that is where a bug report belongs today.**
>
> The Claude Code kit is installed *ahead* of the migration on purpose, so that the conventions
> arrive with the first commit rather than being retrofitted onto ten thousand lines. Nothing
> below is aspirational about the kit itself — the skills are real and they work now. What's
> aspirational is the code they'll eventually be pointed at.

**Gable Portal (LumberNow)** is the contractor / B2B customer portal: the surface a builder or
contractor uses to browse the catalogue, price a job, place and track orders, view invoices and
AR, and manage their team.

Which means the most valuable thing you can contribute **right now** is not code. It's a
written description of how contractor purchasing actually works at your business — because
that's the specification the migration will be built against, and it doesn't exist yet.

---

## What Claude Code is

Claude Code is a command-line tool from Anthropic. You point it at a folder, describe what you
want in ordinary English, and it reads the files, runs commands, and makes changes — showing
you each step and asking before it does anything significant.

It is not magic and it is not always right. Think of it as a fast, tireless assistant who has
read the whole ecosystem but has never run a contractor account. You supply the judgement.

### Install it

1. **Get the repository onto your computer.** You need [Git](https://git-scm.com/downloads).
   ```bash
   git clone https://github.com/FutureBuildAIinc/gable-portal.git
   cd gable-portal
   ```
2. **Install Claude Code.** Follow the official instructions at
   <https://docs.claude.com/en/docs/claude-code/overview>. You will need a Claude account.
3. **Start it, from inside the `gable-portal` folder:**
   ```bash
   claude
   ```

That's it. Type what you want in plain English and press enter.

### The kit loads itself

This repository ships a `.claude/` folder containing everything below — the skills, the
slash-command shortcuts, and a `settings.json` that pre-approves the Go and Node toolchain
commands the gates need (`go build`, `go vet`, `go test`, `gofmt`, `npx tsc --noEmit`,
`npm run lint`, `npm run test`, `npm run build`, `npm ci`), plus `reuse lint` and read-only
`git`, while blocking reads of `.env` files. When you start Claude Code from inside
`gable-portal`, it picks all of that up automatically.

You don't install anything. You don't configure anything. It's already there.

Because the repository is empty, the skills are written to **discover** rather than assume:
they check for a `Makefile`, a `package.json`, a `go.mod`, and a CI workflow, and run whatever
is actually there. Whatever the `Makefile` and CI say **wins over the skill**. That's the design
— it means the kit won't go stale the day the code lands.

---

## The skills

A **skill** is a set of instructions Claude follows for a particular kind of job. You never have
to name one — describe what you want and the right skill activates. Each also has a **slash
command** shortcut if you prefer.

| Skill | Shortcut | Use it when |
|---|---|---|
| **describe-a-workflow** | `/describe-workflow` | You know how contractor purchasing really works — job-based ordering, quote-to-order, jobsite delivery scheduling, AR self-service, approval structure, month-end reconciliation — and want it captured as a spec an engineer can build from. **The highest-value contribution to this repository today, and it requires no coding.** |
| **report-an-issue** | `/file-issue` | Something in the portal behaved wrong. Claude's first job is **routing** — with no code here, it will help you file where it can actually be acted on. |
| **improve-docs** | `/fix-doc` | A doc is wrong or missing. Creating one is a contribution, but only if you can verify what you write. |
| **licensing-check** | `/license-of` | "Which licence covers this?", "Do I have to open-source my changes?", "Can my company use it?" |
| **check-my-contribution** | `/preflight` | You're about to open a pull request. Discovers the gates, runs exactly what CI runs, then SPDX, `reuse lint`, secrets, and PR target. |

---

## Two worked examples

### 1 · You run a builder's back office and nobody has written down how you buy lumber

This is the contribution the repository needs most, and you will never open a code editor.

**Type this:**

> Let me explain how our purchasing actually works. We run everything by job number, and
> reconciling a month of yard purchases takes our bookkeeper two days.

**What happens:** Claude runs the `describe-a-workflow` skill and becomes your scribe. It will:

- **Orient itself first** against the reference implementation so it can ask *"what's different
  about yours?"* rather than *"how does ordering work?"*. It knows, and will tell you, that
  orders today flow `DRAFT → CONFIRMED → FULFILLED` plus `ON_HOLD`, with no will-call/pickup
  path and no separate picking step; and that fulfilling an order produces one tax-inclusive
  invoice plus a balanced `DR Accounts Receivable / CR Sales Revenue` GL entry and an AR
  subledger debit, in a single transaction.
- **Interview you one question at a time**, following the tangents — because that's where the
  requirements live. What's it called at your business? Who does it? What must be true before it
  can happen — credit, stock, truck, approval? What happens when it isn't? Who can override, and
  does anyone record it? What changes at month-end?
- Ask at **every** step: does this move stock, create a charge, take a payment, or change what
  the customer owes?
- Write it up with **three** kinds of acceptance criteria: technical (what an automated test
  asserts, including the *illegal* state transitions), production-readiness (auth and tenant
  scoping, atomicity, reversible migrations, rollback plan, observability), and a **numbered
  walkthrough a real user runs** to confirm it was built right.
- Name the unit of measure on every quantity and the tax basis on every money field. *"500 board
  feet, tax-exclusive"* is a spec; *"the total"* isn't.
- Put what you don't know in §12 as an open question rather than silently deciding it.

Your process is the requirement. If Claude thinks a step is wrong, it goes in the open-questions
section — **it does not quietly redesign your business.**

### 2 · You hit a bug in the portal today

**Type this:**

> The invoice list in the customer portal shows my balance as $73,887.00 but we owe $738.87.

**What happens:** the `report-an-issue` skill, and the first two things it does are the
important ones.

**It checks whether this is a security problem.** Seeing another customer's data, reaching a
page without logging in, an unauthorised money change — none of those go in a public issue.
(With one exception people trip over: the Gable demo and staging deployments run with
`AUTH_MODE=dev`, which intentionally disables login and treats everyone as a seeded admin. On
*those* hosts, with fake data, that's expected.)

**Then it routes.** Since this repository has no code, Claude will say so plainly and help you
file against [`FutureBuildAIinc/gable`](https://github.com/FutureBuildAIinc/gable) instead —
whose kit has a landmines checklist that will make the report much better.

And it knows this specific landmine: **portal money is dollars, not cents.** The ERP API returns
`int64` cents; the portal API returns `float64` dollars — sometimes on the same underlying
column. Rendering one as the other turns `$738.87` into `$73,887.00`, which is exactly the 100×
you're seeing. It'll also check the other known ones: AR balance is **derived** from open
invoices, not read from the denormalised `customers.balance_due` column; portal auth is a
separate JWT path from ERP auth; parts of `/api/portal/v1/*` are public by design; and demo data
is truncated on every deploy.

The maintainer gets a report naming the likely mechanism. That's a complete contribution.

---

## The ground rules

These apply whether or not you used AI — and they apply from the first commit, which is the
point of installing the kit early.

**1 · Pull requests target `staging`, never `master`.**
Maintainers fast-forward `staging → master` after review. If your clone doesn't have `staging`
yet, branch from the default branch and still open the PR **against `staging`**.

**2 · Never commit a secret.**
No API keys, tokens, passwords, connection strings, or `.env` files. If one lands in a commit,
deleting it later doesn't help — it stays in history. **Rotate the credential first**, then
rewrite the branch before pushing. The kit's `.claude/settings.json` blocks reading `.env` files
for exactly this reason.

Related: never introduce `AUTH_MODE=dev` into any config that could reach a public host. It is
fine on demo/staging with fake data and never anywhere else.

**3 · The SPDX header must match the directory.**
**Documentation and everything under `.claude/` is `LicenseRef-OpenLBM-Docs-1.0`**; the licence
text is in [`LICENSES/`](./LICENSES/). **Code** in this repository is governed by its own
Profile — Commons / Community-Source, per the OpenLBM repo map — **not** by the Docs Profile.

When code lands here it will bring a `LICENSE-MAP.md` and a `REUSE.toml` with it, and **those
are authoritative over any skill or over this document.** Order of authority: the file's own
`SPDX-License-Identifier` → `REUSE.toml` → `LICENSE-MAP.md`. Until then, the canonical Standard
is at <https://github.com/FutureBuildAIinc/openlbm> and the reference per-component map is
[`LICENSE-MAP.md` in `FutureBuildAIinc/gable`](https://github.com/FutureBuildAIinc/gable/blob/master/LICENSE-MAP.md).

Header formats: `//` for Go and TypeScript, `--` for SQL, an HTML comment for Markdown, `#`
comments **inside** YAML frontmatter for files that have any, and a `<filename>.license` sidecar
for anything that can't hold a comment. Ask with `/license-of <path>` if unsure, and run
`reuse lint` before you push.

**4 · Security problems go through the private channel, not a public issue.**
This repository has no `SECURITY.md` of its own yet, so follow
[the policy in `FutureBuildAIinc/gable`](https://github.com/FutureBuildAIinc/gable/blob/master/SECURITY.md):
the **Security** tab → **Report a vulnerability**, or **security@futurebuild.ai**. A public issue
tells every operator about the hole before a fix exists.

**5 · Never paste in competitor material.**
Describe how BisTrack, Spruce, or Agility behave from memory if it's useful. Do not paste their
documentation, schemas, screenshots, or API specifications into this repository.

**6 · No real customer data** in examples, specs, issues, or screenshots.

**7 · Run `/preflight` before you push**, and keep it to one concern per PR.

**8 · Contributions are licensed under the Profile governing the files you touched, via a CLA.**
You'll be asked to agree before your first merge.

---

## An honest note about AI-assisted contributions

**AI-assisted contributions are welcome here.** We built this kit on purpose. We would rather
have a contractor's real purchasing process filtered through an AI assistant than not have it at
all.

But there's a bargain, and it isn't negotiable:

> **You are responsible for what you submit.** Your name goes on the pull request. When a
> reviewer asks "why does this work?", "AI wrote it" is not an answer.

There is an extra trap while this repository is empty: **an AI asked about a codebase that
doesn't exist will happily describe one.** If Claude tells you about a file, an endpoint, or a
screen in `gable-portal`, check that it exists before you believe it. The skills are written to
run `ls -a` first and say plainly when there's nothing here — but you are the backstop.

Concretely, before you open a PR:

- **Read every line of the diff.** If you don't understand a change, ask Claude to explain it
  until you do — or drop it.
- **Run it yourself.** Run `/preflight`. Actually start the thing and click it.
- **Check the facts.** Claude can state a wrong file path or a plausible-sounding command with
  complete confidence. If a command in a skill doesn't exist, that's a bug — file it with
  `/file-issue`.
- **Don't submit what you can't defend.** A one-line fix you understand beats a 500-line
  refactor you don't.
- **Say that you used AI** in the PR description. Nobody minds. It helps reviewers know where to
  look hardest.

And the flip side: **a workflow spec is a complete contribution.** You do not have to submit
code. Right now, in this repository, it's worth considerably more than code would be.

---

## Where to go next

| You want to… | Go to |
|---|---|
| See the portal code that exists today | [`FutureBuildAIinc/gable`](https://github.com/FutureBuildAIinc/gable) → `app/src/pages/portal/`, `backend/internal/portal/` |
| Build and run Gable locally | [`FutureBuildAIinc/gable`](https://github.com/FutureBuildAIinc/gable) → `README.md` |
| Understand the conventions, the money boundary, the gotchas | [`FutureBuildAIinc/gable`](https://github.com/FutureBuildAIinc/gable) → `CLAUDE.md` |
| Understand the branch model, PR workflow, CLA | [`FutureBuildAIinc/gable`](https://github.com/FutureBuildAIinc/gable) → `CONTRIBUTING.md` |
| Read the architecture and reference docs | [`FutureBuildAIinc/gable-docs`](https://github.com/FutureBuildAIinc/gable-docs) |
| Understand the licensing Standard and the three gates | <https://github.com/FutureBuildAIinc/openlbm> |
| Build an installable app against the plug-in seam | [`FutureBuildAIinc/gable-sdk`](https://github.com/FutureBuildAIinc/gable-sdk) |
| Use the Gable name or logo | [`FutureBuildAIinc/brand`](https://github.com/FutureBuildAIinc/brand) |
| Report a security problem | [`gable/SECURITY.md`](https://github.com/FutureBuildAIinc/gable/blob/master/SECURITY.md) |
