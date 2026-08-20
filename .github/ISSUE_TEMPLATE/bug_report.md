---
name: Bug report
about: Something in the portal behaves differently from how it is documented
title: ""
labels: bug
assignees: ""
---

<!--
SPDX-License-Identifier: LicenseRef-OpenLBM-Docs-1.0
SPDX-FileCopyrightText: 2026 FutureBuild, Inc. and OpenLBM contributors

STOP — is this a security problem?
If it involves the dealer's Anthropic API key, the admin console, the admin
token, path traversal, or anything an unauthenticated caller can reach:
do NOT open this issue. Follow SECURITY.md instead.

Is it a MONEY problem?
A wrong total, a wrong unit price, a wrong quantity, a wrong tax or fee, a
saving that is not real, or a customer quote that does not match the order it
came from — say so explicitly below and paste the exact numbers you saw. Those
get triaged first, because this is an ordering surface and a formatting bug is
a commercial bug.
-->

## What happened

<!-- One or two sentences. What did you see? -->

## What you expected instead

<!-- And where that expectation comes from: the user guide, CLAUDE.md, a
     tooltip, or plain arithmetic. -->

## Steps to reproduce

1.
2.
3.

## Is money involved?

<!-- Delete the line that does not apply. -->

- [ ] Yes — the numbers below are wrong.
- [ ] No — this is a layout / navigation / copy problem.

If yes, paste the exact figures:

| | Shown | Expected |
|---|---|---|
| Unit price | | |
| Quantity | | |
| Line extended | | |
| Order subtotal | | |

## Environment

- Commit SHA or branch:
- `node --version`:
- Browser and version:
- Screen: phone / tablet / desktop (the layout branches at 768px)
- Which surface: contractor app (`/`) or dealer admin console (`/admin.html`)

## Gates

Please paste the output if you ran them — it usually identifies the layer.

```
npm run typecheck
npm run lint
npm test
npm run build
```

## Anything else

<!-- Screenshots help a lot for layout problems. For money problems the numbers
     above help more than a screenshot does. -->
