// SPDX-License-Identifier: LicenseRef-OpenLBM-Community-Source-1.0
// SPDX-FileCopyrightText: 2026 FutureBuild, Inc. and OpenLBM contributors
import type { ServerResponse } from 'node:http';
import type { Plugin } from 'vite';
import { brandingCss } from '../src/core/domain/config';
import { createAdminHandler } from './admin-api';
import { readConfig } from './admin-store';
import { mountApiBehindHostCheck } from './dev-middleware';
import { PORTAL_API_PREFIX, RUNTIME_GLOBAL, createGableProxy } from './gable-proxy';

/**
 * Serves the dealer's runtime configuration, and mounts the admin API.
 *
 * The no-flash decision: config is INJECTED INTO THE HTML at serve time rather
 * than fetched after boot. A dealer's brand colour arriving one round trip
 * late means every contractor sees the default blue flash to the dealer's
 * colour on every load, which reads as a broken deployment. Injecting also
 * means branding survives with JavaScript still parsing.
 *
 * `/api/config` exists anyway for the embeddable future, where the host page
 * is not ours to inject into.
 */

export interface AdminPluginOptions {
  adminToken: string | undefined;
  allowRemote: boolean;
  /**
   * The ERP to proxy to in dev. Unset = standalone, which is the default and
   * what keeps `npm run dev` working with nothing else running.
   */
  gableApiUrl?: string | undefined;
  /** See `GableProxyOptions.allowInsecureCookies`. Dev is http, so usually true. */
  gableAllowInsecureCookies?: boolean;
}

/** The marker the HTML carries; the client reads it before first paint. */
export const CONFIG_GLOBAL = '__GABLENOW_CONFIG__';

export function renderConfigTags(config: ReturnType<typeof readConfig>): string {
  // JSON is escaped for a <script> context: a literal `</script>` inside a
  // string value would otherwise close the tag and turn config into markup.
  const json = JSON.stringify(config)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026');

  return [
    `<script>window.${CONFIG_GLOBAL}=${json};</script>`,
    // brandingCss re-validates the colour, so this cannot become an injection
    // point even if the config file was edited by hand.
    `<style id="ln-dealer-brand">${brandingCss(config)}</style>`,
  ].join('\n');
}

export function adminPlugin(options: AdminPluginOptions): Plugin {
  const gable = createGableProxy({
    apiUrl: options.gableApiUrl,
    allowInsecureCookies: options.gableAllowInsecureCookies ?? false,
  });

  return {
    name: 'gablenow-admin',

    // Branding and flags are in the document before the first byte of app JS.
    transformIndexHtml() {
      return [
        {
          tag: 'script',
          injectTo: 'head-prepend',
          children: `window.${CONFIG_GLOBAL}=${JSON.stringify(readConfig())
            .replace(/</g, '\\u003c')
            .replace(/>/g, '\\u003e')
            .replace(/&/g, '\\u0026')};`,
        },
        {
          // Dev has to answer the wired-or-standalone question the same way
          // production does, or the two modes diverge in the one place a
          // developer never looks: what the document said before the app ran.
          tag: 'script',
          injectTo: 'head-prepend',
          attrs: { id: 'gable-runtime' },
          children: `window.${RUNTIME_GLOBAL}=${JSON.stringify({
            wired: gable.enabled,
            basePath: `${PORTAL_API_PREFIX}/v1`,
          })};`,
        },
        {
          tag: 'style',
          injectTo: 'head',
          attrs: { id: 'ln-dealer-brand' },
          children: brandingCss(readConfig()),
        },
      ];
    },

    configureServer(server) {
      const admin = createAdminHandler({
        token: options.adminToken,
        allowRemote: options.allowRemote,
      });

      // Registered from the RETURNED function so these sit BEHIND Vite's
      // hostCheckMiddleware. Added in the hook body they would run ahead of it,
      // and a DNS-rebinding page could reach the admin API with `isLoopback`
      // satisfied — the TCP peer genuinely is 127.0.0.1 under that attack.
      //
      // Then relocated in front of the HTML fallback, without which the admin
      // console talks to the SPA and every call dies in JSON.parse. See
      // server/dev-middleware.ts.
      return () => {
        // Public read model. Everything here is visible to every visitor by
        // design — there is no secret in DealerConfig to leak.
        server.middlewares.use('/api/config', (_req, res) => {
          const response = res as ServerResponse;
          response.statusCode = 200;
          response.setHeader('content-type', 'application/json');
          response.setHeader('cache-control', 'no-store');
          response.end(JSON.stringify(readConfig()));
        });

        server.middlewares.use('/api/admin', (req, res) => {
          void admin(req, res as ServerResponse, req.url ?? '');
        });

        /**
         * Connect STRIPS the mount prefix from `req.url`, so inside this
         * handler a request for `/api/portal/v1/catalog` arrives as
         * `/v1/catalog`. The ERP needs the whole path back or every call 404s —
         * the same class of bug `preserve_path_prefix` exists for on App
         * Platform, and it fails identically silently.
         */
        server.middlewares.use(PORTAL_API_PREFIX, (req, res) => {
          void gable.handle(req, res as ServerResponse, `${PORTAL_API_PREFIX}${req.url ?? ''}`);
        });

        mountApiBehindHostCheck(server, ['/api/config', '/api/admin', PORTAL_API_PREFIX]);
      };
    },
  };
}
