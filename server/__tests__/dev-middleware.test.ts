// SPDX-License-Identifier: LicenseRef-OpenLBM-Community-Source-1.0
// SPDX-FileCopyrightText: 2026 FutureBuild, Inc. and OpenLBM contributors
import { request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import { resolve } from 'node:path';
import { type ViteDevServer, createServer } from 'vite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminPlugin } from '../admin-plugin';
import { claudeProxyPlugin } from '../claude-proxy';

/**
 * The dev server's API surface, exercised over a real socket.
 *
 * This file exists because its absence hid a total outage of every dev API
 * route. Registering middleware from `configureServer`'s post-hook puts it
 * BEHIND `viteHtmlFallbackMiddleware`, which rewrites `req.url` to
 * `/index.html` whenever `Accept` contains `text/html` or `*​/*` — a browser's
 * default. Connect then matches routes against the rewritten URL, so
 * `/api/admin/state` stopped matching `/api/admin` and the SPA answered
 * instead. The admin console died in `JSON.parse('<!doctype html>')`.
 *
 * It survived every existing check:
 *   - the proxy suite mounts the handler directly on `http.createServer`, so
 *     it never sees Vite's stack at all;
 *   - the admin suite does the same;
 *   - the security smoke asserted on STATUS, and the SPA fallback answers 200.
 *
 * So the assertions here are deliberately CONTENT-based and send the header a
 * browser actually sends. A status code cannot distinguish "mounted" from
 * "fell through to the SPA".
 */

const TOKEN = 'test-admin-token-0123456789abcdef';
let server: ViteDevServer;
let base: string;

beforeAll(async () => {
  server = await createServer({
    root: resolve(__dirname, '../..'),
    configFile: false,
    logLevel: 'silent',
    plugins: [
      // No dealer key: pinned so this suite cannot pick up whatever the admin
      // suite has written to disk.
      claudeProxyPlugin(undefined, { dealerKey: () => undefined }),
      adminPlugin({ adminToken: TOKEN, allowRemote: false }),
    ],
    server: { port: 0 },
  });
  await server.listen();
  const address = server.httpServer?.address();
  if (!address || typeof address === 'string') throw new Error('no port');
  base = `http://127.0.0.1:${address.port}`;
}, 60_000);

afterAll(async () => {
  await server?.close();
});

/** Forge headers `fetch` refuses to send — Host above all. */
function rawRequest(
  path: string,
  headers: Record<string, string>,
): Promise<{ status: number; body: string }> {
  const { port } = server.httpServer?.address() as AddressInfo;
  return new Promise((resolvePromise, reject) => {
    const request = httpRequest(
      { host: '127.0.0.1', port, path, method: 'GET', headers, setHost: false },
      (response) => {
        let body = '';
        response.on('data', (chunk) => {
          body += chunk;
        });
        response.on('end', () => resolvePromise({ status: response.statusCode ?? 0, body }));
      },
    );
    request.on('error', reject);
    request.end();
  });
}

/** What a browser's `fetch()` sends when you do not set headers yourself. */
const BROWSER_ACCEPT = { accept: '*/*' };

describe('API routes survive the HTML fallback', () => {
  it.each([
    ['*/*', '*/*'],
    ['text/html', 'text/html,application/xhtml+xml'],
    ['json', 'application/json'],
  ])('answers health as JSON for Accept: %s', async (_label, accept) => {
    const response = await fetch(`${base}/api/anthropic/health`, { headers: { accept } });
    const body = await response.text();

    expect(body).not.toContain('<!doctype');
    expect(JSON.parse(body)).toEqual({ ok: true, hasKey: false });
  });

  it('serves the dealer config as JSON, not the app shell', async () => {
    const response = await fetch(`${base}/api/config`, { headers: BROWSER_ACCEPT });
    const body = await response.text();

    expect(body).not.toContain('<!doctype');
    expect(JSON.parse(body).branding.companyName).toBeTypeOf('string');
  });

  it('reaches the admin API with a browser Accept header', async () => {
    const response = await fetch(`${base}/api/admin/state`, {
      headers: { ...BROWSER_ACCEPT, 'x-admin-token': TOKEN },
    });
    const body = await response.text();

    expect(body).not.toContain('<!doctype');
    expect(JSON.parse(body).config).toBeDefined();
  });
});

describe('relocating the middleware kept what the post-hook was for', () => {
  it('still refuses an admin request with no token', async () => {
    const response = await fetch(`${base}/api/admin/state`, { headers: BROWSER_ACCEPT });
    expect(response.status).toBe(401);
  });

  /**
   * The reason these routes are in a post-hook at all. Under DNS rebinding the
   * TCP peer really is 127.0.0.1, so only Vite's own host check catches it —
   * and moving the layers earlier must not step in front of it.
   */
  it('still blocks a forged Host, so rebinding cannot reach the admin API', async () => {
    // Raw http.request, NOT fetch: Node's fetch silently drops a Host header
    // you set, so the forged request arrives with the real one and the test
    // passes without ever having tested anything.
    const { status, body } = await rawRequest('/api/admin/state', {
      host: 'evil.example.com',
      accept: '*/*',
      'x-admin-token': TOKEN,
    });

    expect(status).toBe(403);
    expect(body).not.toContain('companyName');
  });
});

describe('the app itself is untouched', () => {
  it('still serves the SPA at the root', async () => {
    const response = await fetch(`${base}/`, { headers: BROWSER_ACCEPT });
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).toContain('<!doctype');
    expect(body).toContain('__GABLENOW_CONFIG__');
  });

  it('still falls back to the SPA for an unknown app route', async () => {
    const response = await fetch(`${base}/orders/ord_miller_frame`, { headers: BROWSER_ACCEPT });
    expect(await response.text()).toContain('<!doctype');
  });
});
