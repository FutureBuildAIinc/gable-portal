<!--
SPDX-License-Identifier: LicenseRef-OpenLBM-Docs-1.0
SPDX-FileCopyrightText: 2026 FutureBuild, Inc. and OpenLBM contributors
-->

# License Map

Gable Portal is licensed **per component**, like every repository in the Gable
ecosystem — but the portal's map is deliberately short. The full text of each
license lives in [`LICENSES/`](LICENSES/), every file additionally carries a
matching `SPDX-License-Identifier` header (or a `.license` sidecar, for formats
that cannot hold a comment), and [`REUSE.toml`](REUSE.toml) encodes the same
mapping in machine-readable form. `.github/workflows/ci.yml` enforces it on
every pull request.

| Path prefix | SPDX license identifier | License text |
|---|---|---|
| `src/`, `index.html`, `admin.html` | `LicenseRef-OpenLBM-Community-Source-1.0` | [LICENSES/LicenseRef-OpenLBM-Community-Source-1.0.txt](LICENSES/LicenseRef-OpenLBM-Community-Source-1.0.txt) |
| `server/` | `LicenseRef-OpenLBM-Community-Source-1.0` | [LICENSES/LicenseRef-OpenLBM-Community-Source-1.0.txt](LICENSES/LicenseRef-OpenLBM-Community-Source-1.0.txt) |
| `scripts/` | `LicenseRef-OpenLBM-Community-Source-1.0` | [LICENSES/LicenseRef-OpenLBM-Community-Source-1.0.txt](LICENSES/LicenseRef-OpenLBM-Community-Source-1.0.txt) |
| `public/`, build config, `.env.example` | `LicenseRef-OpenLBM-Community-Source-1.0` | [LICENSES/LicenseRef-OpenLBM-Community-Source-1.0.txt](LICENSES/LicenseRef-OpenLBM-Community-Source-1.0.txt) |
| Root `*.md`, `docs/` (guide + screenshots) | `LicenseRef-OpenLBM-Docs-1.0` | [LICENSES/LicenseRef-OpenLBM-Docs-1.0.txt](LICENSES/LicenseRef-OpenLBM-Docs-1.0.txt) |
| `.github/`, `.claude/`, `.gitignore` | `LicenseRef-OpenLBM-Docs-1.0` | [LICENSES/LicenseRef-OpenLBM-Docs-1.0.txt](LICENSES/LicenseRef-OpenLBM-Docs-1.0.txt) |

[`LICENSE`](LICENSE) at the repository root is a copy of the Community Source
text — the license that governs the software itself.

## Why this map is flat, and how it differs from `gable`

The host repository, [`gable`](https://github.com/FutureBuildAIinc/gable),
splits its tree across four licenses: **Commons** for the ERP core, **Surface**
for client apps, **Connector** for the third-party integration seam, and
**Docs** for prose. That split exists because `gable` is a commons that third
parties are expected to build *on top of* and *plug into*, so the license has to
change at each of those boundaries — most importantly at `backend/pkg/apps/`,
where copyleft must stop so an outside app can attach without being infected.

Gable Portal has none of those boundaries. It is a **satellite**: a single
deployable product that will consume the host's integration API, and it has no
plug-in seam of its own. There is nothing here for a third party to extend from
the inside, so there is nothing to carve out. One Licensed Work, one license —
the same shape as [`gable-ai-lm`](https://github.com/FutureBuildAIinc/gable-ai-lm).

### One boundary that is *not* a license boundary

`src/core/` is framework-free by construction and guarded by a test
(`src/core/__tests__/architecture.test.ts`) that fails if a UI framework is
imported into it. That is an **architectural** boundary — it exists so the React
layer in `src/ui/` stays replaceable — and it is easy to mistake for a licensing
one. It is not. Both halves are the same Licensed Work under the same license.
If `src/core/` is ever extracted into a genuinely reusable package that other
people are meant to depend on, *that* would be the moment to revisit the map,
and Connector would be the license to look at.

## What Community Source actually means here

`LicenseRef-OpenLBM-Community-Source-1.0` is a **source-available** license, not
an OSI open-source license. In plain terms:

- **The source is public.** Anyone may read it, modify it, build it, run it for
  development, testing, and evaluation, and redistribute it with the license
  intact. That is Section 1 and it applies to everyone.
- **Community Members may run it in production, free, immediately.** The license
  defines a Community Member as an organisation operating fewer than **50
  locations** that is not controlled by (and does not control) an entity above
  **$1B** annual revenue. If that is you — and it is most independent LBM
  dealers, and effectively every contractor — you may run the portal for your
  business at no charge, today, with no Change Date to wait for.
- **Everyone else needs a commercial license to run it in production.** Large
  chains, national buying groups, and anyone offering the portal as a hosted or
  managed service to third parties are outside the community carve-out. They
  keep every other right — read, modify, evaluate, redistribute — but production
  use is fee-bearing.
- **It converts to AGPL-3.0-only after five years**, per released version, on
  that version's own Change Date.

This is a different shape from the host repo's Commons license, and the
difference is intentional. `gable` is the commons that the industry co-owns.
The portal is a value-added satellite that funds it: **free for the community,
fee for the giants.** Both are source-available; only the production-use
condition differs.

The definitive terms are in the license text, not in this summary. Read
[LICENSES/LicenseRef-OpenLBM-Community-Source-1.0.txt](LICENSES/LicenseRef-OpenLBM-Community-Source-1.0.txt)
before relying on any of the above.

## Prose

`LicenseRef-OpenLBM-Docs-1.0` covers the documentation and repository
plumbing — README, the user guide and its screenshots, the strategy note, the
contributor and security policy, CI workflows, issue templates, and the Claude
contributor kit under `.claude/`.

CI config is Docs rather than Community Source on purpose. A GitHub Actions
workflow is not part of the shipped product; nobody "runs the portal in
production" by running our test matrix. Applying a license whose central term is
a production-use condition to a file that can never be used in production would
be noise in the map.

`scripts/` goes the other way, for the same reason inverted. Those five programs
(`a11y-audit`, `security-smoke`, `prod-server-smoke`, `e2e-smoke`,
`contrast-probe`, plus the `capture-guide` harness) drive a running instance of
the product. `npm run predeploy` is a documented step of shipping it, and an
operator can and should point the security smokes at their own deployment. They
ship with the Licensed Work and are licensed with it.

## No third-party marks in the demo catalog

**Every manufacturer in this repository's demo data is fictional.** There are no
real company names, no real trademarks and no real URLs anywhere in the fixture.

`public/images/brands/` holds nine generated SVG wordmarks for invented
manufacturers — Cascade Timber Works, Pinehurst Mills, Northbeam Engineered
Wood, SunGuard Treated Lumber, IronOak Connectors, ThermaLoft Insulation,
SummitLine Roofing, EverDeck Composites and StoneSet Concrete. Each carries the
line "Fictional brand — demo data only" in the artwork, and every `website` in
`src/core/data/brands.json` uses the RFC 2606 reserved `.example` TLD, which is
guaranteed never to resolve.

This is a deliberate constraint, not an accident of the sample data. An earlier
revision shipped AI-generated imitations of nine live manufacturer marks paired
with those companies' real names and websites; it was replaced before this
repository was published. **Contributions must not introduce a real
manufacturer's name, mark or URL into the demo fixture** — depicting a mark you
do not own, next to that company's real identity, is a trademark exposure
whether the artwork is copied or synthesised. See
[ROADMAP.md](ROADMAP.md) → "Known problems we are not hiding".

## Trademark

The Community Source license grants **no** rights in the names or logos "Gable",
"GableLBM", "GableNow", "FutureBuild", or "OpenLBM" (Section 6). Brand use is
governed by the separate trademark policy in the
[OpenLBM Standard](https://github.com/FutureBuildAIinc/openlbm), which is not
mirrored into this repository. A fork must be renamed.

Note that the product's own brand vocabulary is enforced in code: a test in
`src/core/__tests__/review-regressions.test.ts` fails if the string `Gable`
appears in shipped copy outside a PascalCase product identifier
(`GableNow`, `GableMark`). That guard is about not hard-coding a dealer's name
into the UI, but it doubles as a rename checklist for a fork.

## Contributions

Inbound contributions are licensed under the same license that governs the
file(s) you change, via a CLA. See [CONTRIBUTING.md](CONTRIBUTING.md).

## Status

The OpenLBM license texts under `LICENSES/` are **drafts pending counsel** and
are not yet effective as final legal instruments — the Community Source text
still carries unresolved `[COUNSEL: ...]` markers on its termination mechanics,
governing law, and the 50-location / $1B thresholds. The canonical Standard is
at <https://github.com/FutureBuildAIinc/openlbm>; where it and these drafts
disagree, the published Standard governs.
