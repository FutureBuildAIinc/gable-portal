// SPDX-License-Identifier: LicenseRef-OpenLBM-Community-Source-1.0
// SPDX-FileCopyrightText: 2026 FutureBuild, Inc. and OpenLBM contributors
/**
 * The production host. This is the M9 decision CLAUDE.md left open, resolved
 * as narrowly as possible: a plain `http.createServer` that serves the built
 * client, injects the dealer's config per request the same way the Vite
 * plugin does in dev, and mounts the exact same handlers dev already uses.
 *
 * Nothing about the handlers changes for production — `createMessagesHandler`
 * and `createAdminHandler` are already host-agnostic `(req, res) => void`
 * functions, built and tested that way from the start. This file is the thin
 * host wrapper CLAUDE.md said any runtime could supply "in a few lines" —
 * it just also has to serve the static build, which dev left to Vite.
 *
 * Build: `npm run build:server` (esbuild bundles this file; no path aliases
 * to resolve since every server/core import here is already relative).
 * Run:   `node dist-server/serve.mjs`
 */

import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { type IncomingMessage, type ServerResponse, createServer } from 'node:http';
import { extname, join, normalize, resolve } from 'node:path';
import { createAdminHandler } from './admin-api';
import { CONFIG_GLOBAL, renderConfigTags } from './admin-plugin';
import { readConfig, readStoredKey } from './admin-store';
import { createMessagesHandler } from './claude-proxy';
import { PORTAL_API_PREFIX, createGableProxy, renderGableRuntimeTag } from './gable-proxy';

const ROOT = resolve(import.meta.dirname, '..');
const DIST = join(ROOT, 'dist');
const PORT = Number(process.env.PORT ?? 8080);
/**
 * Bind on every interface by default.
 *
 * This used to default to `127.0.0.1` on the reasoning that a tunnel or reverse
 * proxy in front of it connects locally. That reasoning holds for a laptop and
 * is FATAL in a container: on DigitalOcean App Platform (and Docker, and
 * Kubernetes, and Fly) the health checker and the router live outside the
 * container's network namespace, so a process listening on loopback accepts
 * nothing from them. The container starts, logs "serving on
 * http://127.0.0.1:8080", passes every local smoke test, and silently receives
 * zero traffic — a deployment that looks green and is not.
 *
 * The container IS the isolation boundary; binding wider inside it does not
 * widen anything. Set `HOST=127.0.0.1` explicitly for a local-only run.
 */
const HOST = process.env.HOST ?? '0.0.0.0';

if (!existsSync(DIST)) {
  throw new Error(`dist/ not found at ${DIST} — run "npm run build" before "npm run serve".`);
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.map': 'application/json; charset=utf-8',
};

/**
 * The two HTML entry points are read ONCE as templates, not served as static
 * files. `vite build` bakes in whatever config was on disk at BUILD time — a
 * dealer changing branding after deploy would otherwise never see it reflect,
 * since nothing re-renders the file on disk. Each request re-injects fresh
 * config into the cached template, matching what the dev plugin does live.
 */
function loadTemplate(filename: string): string {
  const raw = readFileSync(join(DIST, filename), 'utf8');
  // Strip whatever build-time config the template shipped with — matched by
  // structure, not by exact bytes, so this survives the wordmark or the brand
  // colour changing.
  return (
    raw
      .replace(new RegExp(`<script>window\\.${CONFIG_GLOBAL}=.*?</script>\\n?`, 's'), '')
      .replace(/<style id="ln-dealer-brand">.*?<\/style>\n?/s, '')
      // Same reasoning for the ERP flag: a build produced with GABLE_API_URL set
      // must not hard-code "wired" into a container later run without one.
      .replace(/<script id="gable-runtime">.*?<\/script>\n?/s, '')
  );
}

const indexTemplate = loadTemplate('index.html');
const adminTemplate = loadTemplate('admin.html');

function renderHtml(template: string): string {
  return template.replace(
    '<head>',
    `<head>\n    ${renderConfigTags(readConfig())}\n    ${renderGableRuntimeTag(gable.enabled)}`,
  );
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(payload));
}

function sendHtml(res: ServerResponse, html: string): void {
  res.statusCode = 200;
  res.setHeader('content-type', 'text/html; charset=utf-8');
  // Re-rendered every request; a shared cache holding an old dealer colour is
  // exactly the flash-of-wrong-brand this template dance exists to prevent.
  res.setHeader('cache-control', 'no-store');
  res.end(html);
}

/**
 * Static assets under `dist/assets` and `dist/images` only. Resolved and
 * bounds-checked against DIST so `..` in a URL cannot escape it — the same
 * property `server.fs.deny` gave the dev server, reimplemented here because
 * this server has no Vite underneath it to provide it for free.
 */
function serveStatic(req: IncomingMessage, res: ServerResponse, urlPath: string): boolean {
  const decoded = decodeURIComponent(urlPath.split('?')[0] ?? '');
  const candidate = normalize(join(DIST, decoded));
  if (!candidate.startsWith(DIST)) return false; // traversal attempt

  const ext = extname(candidate);
  if (!(ext in MIME)) return false;
  if (!existsSync(candidate) || !statSync(candidate).isFile()) return false;

  res.statusCode = 200;
  res.setHeader('content-type', MIME[ext] ?? 'application/octet-stream');
  // Filenames are content-hashed by Vite (main-CdATMnbj.js), so a hard cache
  // is safe — a changed file is a changed URL, never a changed response.
  res.setHeader('cache-control', 'public, max-age=31536000, immutable');
  if (req.method === 'HEAD') {
    res.end();
    return true;
  }
  createReadStream(candidate).pipe(res);
  return true;
}

const adminToken = process.env.GABLENOW_ADMIN_TOKEN;
const admin = createAdminHandler({
  token: adminToken,
  allowRemote: process.env.GABLENOW_ADMIN_ALLOW_REMOTE === 'true',
});
const messages = createMessagesHandler(process.env.ANTHROPIC_API_KEY);

/**
 * The link to the supplier's ERP. Absent `GABLE_API_URL` means standalone —
 * a first-class mode, not a broken one: the simulator plays the supplier and
 * the UI says so.
 */
const gable = createGableProxy({
  apiUrl: process.env.GABLE_API_URL,
  allowInsecureCookies: process.env.GABLE_ALLOW_INSECURE_COOKIES === 'true',
});

const server = createServer((req, res) => {
  const url = req.url ?? '/';
  const path = url.split('?')[0] ?? '/';

  /**
   * Health check, and the only endpoint App Platform's router polls before it
   * will send real traffic. Static and dependency-free on purpose: it must
   * answer 200 while the ERP is down, or a `gable` outage would take the portal
   * out of rotation too and the contractor would lose the offline board as
   * well as the live one.
   */
  if (path === '/healthz') {
    sendJson(res, 200, { ok: true, gable: gable.enabled ? 'configured' : 'standalone' });
    return;
  }

  // Everything under /api/portal is the ERP's, verbatim, including the query
  // string — hence `url` and not `path`.
  if (path.startsWith(PORTAL_API_PREFIX)) {
    void gable.handle(req, res, url);
    return;
  }

  if (path === '/api/anthropic/health') {
    // hasKey must reflect the DEALER key too, same contract as dev: a dealer
    // who configured a validated key in the console must not see the
    // assistant render disabled just because ANTHROPIC_API_KEY is unset.
    sendJson(res, 200, {
      ok: true,
      hasKey: Boolean(process.env.ANTHROPIC_API_KEY || readStoredKey()),
    });
    return;
  }
  if (path === '/api/anthropic/v1/messages') {
    void messages(req, res);
    return;
  }
  if (path === '/api/config') {
    res.statusCode = 200;
    res.setHeader('content-type', 'application/json');
    res.setHeader('cache-control', 'no-store');
    res.end(JSON.stringify(readConfig()));
    return;
  }
  if (path.startsWith('/api/admin')) {
    void admin(req, res, path);
    return;
  }
  if (path === '/admin.html') {
    sendHtml(res, renderHtml(adminTemplate));
    return;
  }
  if (serveStatic(req, res, path)) return;

  // SPA fallback: every other path is a client-side route (react-router).
  sendHtml(res, renderHtml(indexTemplate));
});

server.listen(PORT, HOST, () => {
  const tokenState = adminToken ? 'configured' : 'ABSENT — admin console disabled';
  console.log(`GableNow serving on http://${HOST}:${PORT}`);
  console.log(`  admin token: ${tokenState}`);
  console.log(`  anthropic key (env): ${process.env.ANTHROPIC_API_KEY ? 'set' : 'not set'}`);
  console.log(
    gable.enabled
      ? `  gable ERP: ${process.env.GABLE_API_URL} (proxied at ${PORTAL_API_PREFIX})`
      : '  gable ERP: GABLE_API_URL not set — running standalone against the simulator',
  );
  if (process.env.GABLE_ALLOW_INSECURE_COOKIES === 'true') {
    console.warn(
      '  WARNING: GABLE_ALLOW_INSECURE_COOKIES=true — the session cookie will be forwarded without Secure. Local HTTP only.',
    );
  }
});

// Never let this crash silently mid-demo. The proxy already destroys sockets
// rather than throwing through a headers-sent response; this is the backstop
// for anything that gets past that.
process.on('uncaughtException', (error) => {
  console.error('[serve] uncaught exception', error);
});
