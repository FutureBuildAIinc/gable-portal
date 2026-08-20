// SPDX-License-Identifier: LicenseRef-OpenLBM-Community-Source-1.0
// SPDX-FileCopyrightText: 2026 FutureBuild, Inc. and OpenLBM contributors
import type { ViteDevServer } from 'vite';

/**
 * Put our API routes in the one slot in Vite's stack that actually works.
 *
 * There are two constraints and they pull in opposite directions:
 *
 *  - AFTER `viteHostCheckMiddleware`, or a DNS-rebinding page reaches the
 *    admin API with `isLoopback` satisfied — under that attack the TCP peer
 *    genuinely is 127.0.0.1. Registering inside the `configureServer` body
 *    puts middleware in FRONT of the host check, so that is not an option.
 *
 *  - BEFORE `viteHtmlFallbackMiddleware`, which REWRITES `req.url` to
 *    `/index.html` for any request whose `Accept` contains `text/html` or
 *    `*​/*`. Connect matches routes on `req.url`, so after that rewrite
 *    `/api/admin/state` no longer matches `/api/admin` and the request sails
 *    past every API handler into the SPA.
 *
 * Returning a post-hook from `configureServer` satisfies the first and
 * violates the second, which is what shipped: the whole dev API surface —
 * health, config, the Claude proxy, and the entire admin console — answered
 * `200 <!doctype html>` to anything sent with a browser's default `Accept`.
 * Nothing caught it because `fetch()` from the SDK sets
 * `Accept: application/json` and kept working, and because every check we had
 * asserted on STATUS: the SPA fallback answers 200, so "200 means mounted" was
 * never true. Only driving the real server with a real `Accept` header showed
 * it.
 *
 * So: register in the post-hook, then move the layers to sit immediately
 * before the HTML fallback. Both constraints hold, and the reorder is asserted
 * rather than assumed — if a Vite upgrade renames these internals the dev
 * server refuses to start instead of silently serving a dead API again.
 */

const HOST_CHECK = 'viteHostCheckMiddleware';
const HTML_FALLBACK = 'viteHtmlFallbackMiddleware';

export function mountApiBehindHostCheck(server: ViteDevServer, routes: string[]): void {
  const stack = server.middlewares.stack;
  // A connect handle is a function OR an http.Server; only the former is named.
  const nameOf = (layer: (typeof stack)[number]) =>
    typeof layer.handle === 'function' ? layer.handle.name : '';
  const indexOf = (name: string) => stack.findIndex((layer) => nameOf(layer) === name);

  const hostCheck = indexOf(HOST_CHECK);
  const fallback = indexOf(HTML_FALLBACK);

  if (hostCheck === -1 || fallback === -1 || hostCheck > fallback) {
    throw new Error(
      `[gablenow] cannot place API middleware: expected ${HOST_CHECK} before ${HTML_FALLBACK} in Vite's stack (found ${hostCheck} and ${fallback}). Vite's internals changed — fix server/dev-middleware.ts rather than letting the API fall through to the SPA.`,
    );
  }

  // Ours are all registered after the fallback, so lifting them out from the
  // back leaves `fallback` pointing at the same layer.
  const ours: (typeof stack)[number][] = [];
  for (let i = stack.length - 1; i > fallback; i -= 1) {
    const layer = stack[i];
    if (layer && routes.includes(layer.route)) ours.unshift(...stack.splice(i, 1));
  }

  if (ours.length !== routes.length) {
    throw new Error(
      `[gablenow] expected to relocate ${routes.length} API routes (${routes.join(', ')}) ` +
        `but found ${ours.length}. They must be registered before this is called.`,
    );
  }

  stack.splice(fallback, 0, ...ours);
}
