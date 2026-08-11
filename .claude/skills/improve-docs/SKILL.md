---
# SPDX-License-Identifier: LicenseRef-OpenLBM-Docs-1.0
# SPDX-FileCopyrightText: 2026 FutureBuild, Inc. and OpenLBM contributors
name: improve-docs
description: Fix or write documentation in the Gable Portal (LumberNow) repository — verified against the actual code, with working links and the correct SPDX header, opened as a PR against staging. Use when the user says "this doc is wrong", "the README is out of date", "the setup instructions don't work", "document this", "fix a typo", "improve the docs", "/fix-doc".
---

# improve-docs — make the docs match the code

**A doc fix is done when you have run the thing the doc describes**, not when it reads well.

This repository holds the contractor / B2B customer portal — the surface a builder or contractor uses to browse the catalogue, price a job, place and track orders, view invoices and AR, and manage their team. It is being populated — so the first thing to check is what
is actually here.

---

## 1 · Find the target

```bash
ls -a
ls docs/ 2>/dev/null
grep -rn "the phrase they remember" --include='*.md' . | grep -v '\.git/' | head -20
```

If a document you'd expect doesn't exist yet, **creating it is a contribution** — but only if
you can verify what you write (§2). A confident wrong doc is worse than a gap.

## 2 · Verify before you edit

**A command?** Run it. If it fails, that failure *is* the bug and the corrected command is the
fix. Paste the real error in the PR.

**A path or filename?** `ls` it.

**A claim about behaviour?** Find it in the code and cite `file:line`. Where behaviour lives in
the core ERP rather than here, check it there:

```bash
git clone --depth 1 https://github.com/FutureBuildAIinc/gable.git /tmp/gable
grep -rn "<the thing>" /tmp/gable/backend/internal/ | head
```

**A version, port, or default?** Read it from the source of truth — `go.mod`, `package.json`,
`docker-compose.yml`, `.github/workflows/ci.yml` — not from another doc.

### Easy things to document wrongly

- **Portal money is dollars, not cents.** The ERP API returns `int64` cents; the portal API returns `float64` dollars — sometimes on the same underlying column. Mixing the two renders `$738.87` as `$73,887.00`. See the money table in the `gable` repo's `CLAUDE.md`.
- **Portal auth is separate from ERP auth.** The portal has its own JWT path, and under `AUTH_MODE=dev` it is bypassed and injects demo customer claims. Never rely on that in a design.
- **Parts of `/api/portal/v1/*` are public** by design (login, config). Anything added there needs deliberate thought about what an unauthenticated caller can see.
- **AR balance is derived, not read.** Compute it live from open invoices rather than trusting the denormalised `customers.balance_due` column.
- **Say "as built" or "planned".** Where a doc describes something that doesn't exist yet, label
  it. Undated aspiration is how documentation goes bad.

## 3 · Write it

- **Match the surrounding voice** — direct, second person, short paragraphs, tables for anything
  enumerable.
- **Prefer deleting a wrong sentence to hedging it.**
- **Use real, runnable examples** with fixture data, never real customer records.
- **Show real paths**, not "the service".
- **Don't restructure a whole document** in a typo PR. One concern per PR.

## 4 · SPDX header

Documentation here is `LicenseRef-OpenLBM-Docs-1.0`. New Markdown carries it inline:

<!-- REUSE-IgnoreStart -->

```markdown
<!--
SPDX-License-Identifier: LicenseRef-OpenLBM-Docs-1.0
SPDX-FileCopyrightText: 2026 FutureBuild, Inc. and OpenLBM contributors
-->
```

<!-- REUSE-IgnoreEnd -->

A file that opens with `---` frontmatter puts the tags as `#` comments **inside** the
frontmatter so it still parses. Binaries get a `<filename>.license` sidecar.

Note that **code** in this repository is governed by its own profile — Commons / Community-Source (per the OpenLBM repo map) — not by
the Docs profile. Use the **`licensing-check`** skill if you're unsure which applies.

## 5 · Check the links

```bash
for f in $(git diff --name-only); do
  case "$f" in *.md)
    grep -oE '\]\([^)#][^)]*\)' "$f" | tr -d '](' | while read -r l; do
      case "$l" in
        http*) echo "external (open it): $l" ;;
        *) [ -e "$(dirname "$f")/${l%%#*}" ] && echo "ok:     $l" || echo "BROKEN: $l" ;;
      esac
    done ;;
  esac
done
```

Deep links into other repositories are the ones that rot. Prefer linking a **file** over a
**line number**.

## 6 · Open the PR

```bash
git fetch origin
git switch -c docs/<short-description> origin/staging
```

> If that fails with `invalid reference: origin/staging`, this clone doesn't have `staging` —
> branch from the default branch and still open the PR **against `staging`**.

Say what was wrong (quote it), what it should say, and **how you verified it**. That last part
is what gets docs PRs merged quickly. Then run **`check-my-contribution`**.

---

## Ground rules

- **Verify before you edit.** Run the command, check the path, read the code.
- **Never document something you haven't confirmed exists.**
- **Label aspirational features as planned.**
- **No secrets, no live hostnames, no real customer data** in examples.
- **One concern per PR.** PRs target `staging`.
