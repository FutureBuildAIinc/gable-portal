<!--
SPDX-License-Identifier: LicenseRef-OpenLBM-Docs-1.0
SPDX-FileCopyrightText: 2026 FutureBuild, Inc. and OpenLBM contributors
-->

# Security Policy

Thanks for helping keep Gable Portal — and the dealers and contractors who
might one day run it — safe. This document explains how to report a
vulnerability privately, what is in scope, how quickly you can expect a
response, and the handful of things about this codebase you need to understand
before deploying it anywhere.

## Reporting a vulnerability

**Do not open a public issue, pull request, or discussion for a security
problem.** A public report exposes every operator running the code before a fix
exists. There is no exception to this, not even for "it's only the demo".

Use one of these private channels:

1. **GitHub Security Advisories (preferred).** From this repository, open the
   **Security** tab → **Report a vulnerability**. That starts a private advisory
   visible only to you and the maintainers:
   <https://github.com/FutureBuildAIinc/gable-portal/security/advisories/new>
2. **Email — <colton@futurebuild.ai>.** Send a first contact if you would rather
   arrange an encrypted channel before sharing details. Anonymous reports are
   accepted; if you want credit in the advisory, say how you would like to be
   named.

To help us triage quickly, please include:

- The affected component and path (`server/...`, `src/core/...`, `src/admin/...`,
  `scripts/...`).
- The commit SHA or branch you tested against.
- A minimal reproduction, proof of concept, or the vulnerable code path.
- Impact: what an attacker can read, write, or bypass. For this repository
  specifically, say whether the finding reaches **the dealer's Anthropic API
  key** — that is the one live credential in the system and the difference
  between a bug and an incident.
- Any suggested remediation, if you have one.

## Supported branches

| Branch | Supported | Notes |
|---|---|---|
| `main` | Yes | The only branch today. Security fixes land here first. |
| Forks / vendored copies | No | Rebase onto a patched `main` and re-apply local changes. |

There is no long-term-support line. Run a recent `main` to stay patched.

## Response window

Targets, not contractual guarantees, for a small maintainer team:

| Stage | Target |
|---|---|
| Acknowledge your report | within **3 business days** |
| Initial assessment (severity, affected versions) | within **7 days** |
| Fix or documented mitigation for confirmed high/critical issues | within **90 days**, coordinated with you |

We follow **coordinated disclosure**: we agree a date with you, credit you in
the advisory unless you prefer otherwise, and publish the fix and the advisory
together.

## Scope

**In scope:** everything in this repository — the React app under `src/`, the
dealer admin console under `src/admin/`, the Node handlers and production host
under `server/`, and the audit scripts under `scripts/`.

**Out of scope:** vulnerabilities in third-party dependencies (report those
upstream; Dependabot tracks them for us), the fictional demo seed data itself,
and anything in the upstream `gable` ERP — report those to that project.

---

## The thing you must understand first

### There is no authentication on the contractor app

This is not a bug and it is not a finding. It is the current state of the
product, stated here so nobody deploys it thinking otherwise.

The contractor-facing app at `/` has **no login, no session, no server-side
authorisation, and no server-side state at all.** Everything a contractor sees
lives in that browser's `localStorage`. The team/role switcher in the UI changes
which capability gates apply, and those gates are real code
(`src/core/actions/team.ts` → `requireCapability`), but they are **client-side
UX guardrails, not a security boundary**. Anyone with DevTools can edit the
store directly.

**Therefore:**

1. **Never put real customer, contractor, or dealer data into a deployed
   instance of this app.** Not a real homeowner's name, not a real address, not
   a real order.
2. **Never expose a deployment to the public internet** except as a demo
   containing only the fictional seed data.
3. Do not report "the role switcher can be bypassed" or "localStorage can be
   edited" as vulnerabilities. Both are true, both are known, and both follow
   from there being no server. See [ROADMAP.md](ROADMAP.md).

The interesting attack surface is therefore **not** the contractor app. It is
the small amount of server that does exist.

---

## The two settings that matter

### 1. `GABLENOW_ADMIN_TOKEN` gates the only real credential in the system

The dealer admin console at `/admin.html` is the one surface with a
server-side secret behind it: the dealer's Anthropic API key. Its protections,
which a change must not weaken:

- **Absent token = disabled, not open.** `server/admin-api.ts` `authorize()`
  refuses **every** request when no token is configured. There is deliberately
  no open-by-default mode, because an admin surface that accepts an API key must
  fail closed. `server/serve.ts` prints `admin token: ABSENT — admin console
  disabled` at startup so this is visible rather than silent.
- **Loopback only, unless you say otherwise.** Non-loopback callers are refused
  unless `GABLENOW_ADMIN_ALLOW_REMOTE` is exactly `"true"`. Set that only if you
  knowingly run `vite --host` and accept LAN exposure.
- **Constant-time comparison.** Token checking uses
  `crypto.timingSafeEqual`, not `===`.
- **The key is write-only.** It is stored in `.gablenow/secrets.json` (file mode
  `0600`, directory mode `0700`, gitignored) and **never returned to a client**.
  `DealerConfig` — the object that *is* sent to the browser — has no field that
  could carry it; the admin UI only ever learns `assistant.hasCredential:
  true|false`. A shape that cannot carry the secret cannot leak it.
- **The directory is denied at the web layer too.** `vite.config.ts` sets
  `server.fs.deny` to `['.env', '.env.*', '*.{crt,pem}', '**/.gablenow/**',
  '**/.git/**']`. The `**/` prefixes are load-bearing: patterns match the
  absolute path, and an earlier attempt without them matched nothing while
  looking correct. `GET /.gablenow/secrets.json` handing out the dealer's key
  over plain HTTP is a bug that actually shipped once.

Generate a token with `openssl rand -hex 32`. Never commit one, never put one in
a fixture, never paste one into an issue.

**If you find any reachable environment serving `/admin.html` without a token
configured, or any path that returns the contents of `.gablenow/`, report it
through the private channels above.**

### 2. The Anthropic key belongs to the dealer, and the proxy is the only thing between it and the internet

`server/claude-proxy.ts` is a same-origin proxy. The browser never holds the
dealer's key; it sends a placeholder in `x-api-key` and the proxy swaps in the
real one server-side. A contractor may also supply their own key (BYOK), which
is stored in *their* browser and forwarded through **this same proxy** rather
than going direct — deliberately, so the caps below apply to both.

Its limits, all of which are tested in `server/__tests__/claude-proxy.test.ts`:

| Control | Value |
|---|---|
| Per-client token bucket | capacity 20, refill 0.5/sec |
| Request body ceiling | 12 MB |
| `max_tokens` ceiling | 32,000, enforced regardless of what the client asks for |
| Daily request cap | dealer-configured, counted server-side per UTC calendar day, per contractor |

Two behaviours are deliberate and should not be "fixed" without discussion:

- **A cap that cannot be read fails open.** If the counter file is unreadable —
  full disk, read-only mount — the proxy logs and allows the request rather than
  taking the assistant down. Denial of service to the dealer was judged worse
  than one uncounted request.
- **The key is never read ambiently.** Handlers take the key as an argument
  rather than reaching for `process.env` or the store at call time. A health
  route that read the stored key ambiently was a real defect once; the argument
  form is what makes the tests able to prove the routing.

## Hardening notes for anyone deploying this

- **`HOST` defaults to `127.0.0.1` in `server/serve.ts`, and should stay
  there.** Whatever fronts the process — a tunnel, a reverse proxy — connects
  locally. Binding wider adds LAN exposure with no benefit.
- **Run `npm run security` and `npm run predeploy` before you deploy.** They are
  twins that attack the dev server and the production host respectively, and
  they share almost nothing at the implementation level — no Vite, no middleware
  stack, a hand-rolled static server — so a defence proven for one says nothing
  about the other. Both cover path traversal, the admin auth gate, and config
  injection. Building the second one caught a false green in the first.
- **The static file server is bounds-checked, and the check is what matters.**
  `serve.ts` resolves every request against `dist/` and rejects anything that
  escapes it. There is also a MIME allowlist, and the two are independent on
  purpose: the traversal test uses a canary with an *allowed* extension
  specifically so it tests the bounds check rather than the extension filter.
- **The two HTML entry points are templates, not static files.** `serve.ts`
  strips the build-time config block and re-injects a fresh one on every
  request. If you change that code, re-verify that exactly one
  `__GABLENOW_CONFIG__` assignment reaches the client — two, with the last
  winning by accident, is the failure mode.
- **The LLM's house rules are additive and cannot replace the safety rules.**
  A dealer can append instructions to the system prompt through the admin
  console; they cannot configure away "never invent a quantity, never invent a
  price". A change that makes `houseRules` able to override the base prompt is a
  security-class change, because the model's output becomes a commercial
  commitment.
- **Assistant-supplied photographs.** The capture flow can photograph whatever
  the camera sees, including another application's window on a desktop. That was
  fixed once and is worth re-checking after any change to the capture path.
