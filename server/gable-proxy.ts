// SPDX-License-Identifier: LicenseRef-OpenLBM-Community-Source-1.0
// SPDX-FileCopyrightText: 2026 FutureBuild, Inc. and OpenLBM contributors
import type { IncomingMessage, ServerResponse } from 'node:http';

/**
 * The same-origin proxy that makes the ERP reachable from the browser at all.
 *
 * This is not a convenience layer. It is forced by how `gable` delivers a
 * session, and the reasoning is worth having written down because "just call
 * the API from the SPA" is the obvious thing to try and it cannot work:
 *
 *   `gable/backend/internal/portal/handler.go` sets the JWT as
 *   `portal_token`, `HttpOnly`, `Path=/api/portal`, `SameSite=Strict`, and
 *   deliberately keeps it out of the response body. A `SameSite=Strict` cookie
 *   is sent ONLY on same-site requests. A portal served from
 *   `portal.example.com` calling `erp.example.com` is cross-site, so the
 *   browser holds the cookie back on every single request and the ERP answers
 *   401 forever — a failure that looks exactly like a bad password.
 *
 * Proxying under the portal's own origin makes every request same-site, and the
 * cookie's `Path=/api/portal` matches unchanged because this proxy mounts at
 * the same path the ERP uses. Nothing about the cookie needs rewriting, which
 * is the property that keeps this file short.
 *
 * It also means `GABLE_API_URL` never reaches the browser. The ERP's address
 * stays server-side, and there is no build-time secret anywhere: the client
 * bundle contains a relative path and nothing else.
 */

/** The path prefix both sides agree on. Must match `GABLE_PROXY_BASE`. */
export const PORTAL_API_PREFIX = '/api/portal';

/** The global the client reads before first paint. Must match `runtime.ts`. */
export const RUNTIME_GLOBAL = '__GABLE_RUNTIME__';

/**
 * Tell the browser which world it is in, in the document, before any JS runs.
 *
 * Same no-flash argument as `DealerConfig`: fetching this would render one
 * frame of the simulated board and then swap it for the live one, and a user
 * who happens to look during that frame has been shown local state dressed as
 * ERP state.
 *
 * Note what is NOT in here: `GABLE_API_URL`. The client only ever needs to know
 * THAT an ERP is configured, never where it is.
 */
export function renderGableRuntimeTag(wired: boolean): string {
  const payload = JSON.stringify({ wired, basePath: `${PORTAL_API_PREFIX}/v1` });
  return `<script id="gable-runtime">window.${RUNTIME_GLOBAL}=${payload};</script>`;
}

/**
 * Hop-by-hop headers, plus the ones that describe the ORIGINAL request body
 * rather than the one being forwarded.
 *
 * `content-length` is on this list for a specific reason: the body is streamed
 * through, and Node recomputes framing for the outbound request. Passing the
 * inbound length through has produced silent truncation when the two disagree.
 */
const STRIPPED_REQUEST_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'host',
  'content-length',
  // Recompressing an already-decoded body is a bug factory; ask for identity.
  'accept-encoding',
]);

const STRIPPED_RESPONSE_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'transfer-encoding',
  'upgrade',
  'content-encoding',
  'content-length',
]);

export interface GableProxyOptions {
  /**
   * The ERP's base URL, e.g. `https://erp.example.com`. Absent means this
   * deployment is standalone and the proxy is not mounted at all.
   */
  apiUrl: string | undefined;
  /**
   * Strip `Secure` from the ERP's `Set-Cookie` on the way back.
   *
   * Needed ONLY when the portal itself is served over plain HTTP — a local
   * `npm run dev`, or a container being smoke-tested before a TLS terminator is
   * in front of it. A `Secure` cookie is silently dropped by the browser on an
   * http:// origin, so without this the login appears to succeed and every
   * subsequent request is a 401.
   *
   * Off by default, and it must stay off anywhere real: turning it on over a
   * network means the session cookie travels in clear text.
   */
  allowInsecureCookies?: boolean;
  fetchImpl?: typeof fetch;
}

export interface GableProxy {
  /** True when an ERP was configured. Drives the injected runtime flag. */
  readonly enabled: boolean;
  /** `(req, res, path) => void`, matching the shape the hosts already mount. */
  handle(req: IncomingMessage, res: ServerResponse, path: string): Promise<void>;
}

/**
 * `Secure` has to be removed as a whole attribute, not as a substring — a
 * cookie value containing the letters "secure" must survive untouched.
 */
export function stripSecureAttribute(setCookie: string): string {
  return setCookie
    .split(';')
    .filter((part) => part.trim().toLowerCase() !== 'secure')
    .join(';');
}

/** Normalise so `https://erp.example.com/` and `.../` join the same way. */
function normaliseBase(apiUrl: string): string {
  return apiUrl.endsWith('/') ? apiUrl.slice(0, -1) : apiUrl;
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export function createGableProxy(options: GableProxyOptions): GableProxy {
  const enabled = Boolean(options.apiUrl);
  const base = options.apiUrl ? normaliseBase(options.apiUrl) : '';
  const doFetch = options.fetchImpl ?? globalThis.fetch.bind(globalThis);

  return {
    enabled,

    async handle(req, res, path) {
      if (!enabled) {
        // Standalone. Answering 404 would read as "wrong URL"; this says which
        // knob is missing, which is the difference between a five-minute fix
        // and an afternoon.
        res.statusCode = 503;
        res.setHeader('content-type', 'application/json');
        res.end(
          JSON.stringify({
            error: {
              code: 'GABLE_NOT_CONFIGURED',
              message:
                'This portal is running standalone against its simulator. Set GABLE_API_URL to point it at a gable ERP.',
            },
          }),
        );
        return;
      }

      const target = `${base}${path}`;
      const headers = new Headers();
      for (const [key, value] of Object.entries(req.headers)) {
        if (value === undefined) continue;
        if (STRIPPED_REQUEST_HEADERS.has(key.toLowerCase())) continue;
        headers.set(key, Array.isArray(value) ? value.join(', ') : value);
      }
      // The ERP's rate limiter and audit log both want the real caller, and
      // behind this proxy every request otherwise appears to come from the
      // portal container.
      const forwardedFor = req.headers['x-forwarded-for'];
      const remote = req.socket.remoteAddress;
      if (!forwardedFor && remote) headers.set('x-forwarded-for', remote);

      const method = req.method ?? 'GET';
      const body =
        method === 'GET' || method === 'HEAD' || method === 'DELETE'
          ? undefined
          : await readBody(req);

      let upstream: Response;
      try {
        upstream = await doFetch(target, {
          method,
          headers,
          ...(body && body.length > 0 ? { body: new Uint8Array(body) } : {}),
          // Never follow a redirect on the client's behalf: a 302 to a login
          // page would arrive at the SPA as a 200 full of HTML and die in
          // JSON.parse, which is a genuinely hard failure to diagnose.
          redirect: 'manual',
        });
      } catch (error) {
        res.statusCode = 502;
        res.setHeader('content-type', 'application/json');
        res.end(
          JSON.stringify({
            error: {
              code: 'GABLE_UNREACHABLE',
              message: `Could not reach the supplier ERP at ${base}.`,
            },
          }),
        );
        console.error('[gable-proxy] upstream failed', { target, error });
        return;
      }

      res.statusCode = upstream.status;

      /**
       * `Set-Cookie` must be forwarded as SEPARATE headers, never joined.
       * `Headers.get('set-cookie')` comma-joins them, and a cookie's `Expires`
       * attribute legally contains a comma ("Mon, 24 Aug 2026 ..."), so the
       * joined string cannot be split back apart correctly. `getSetCookie()`
       * exists precisely for this and is the only correct read.
       */
      const cookies = upstream.headers.getSetCookie();
      if (cookies.length > 0) {
        res.setHeader(
          'set-cookie',
          options.allowInsecureCookies ? cookies.map(stripSecureAttribute) : cookies,
        );
      }

      upstream.headers.forEach((value, key) => {
        const lower = key.toLowerCase();
        if (lower === 'set-cookie') return; // handled above, as an array
        if (STRIPPED_RESPONSE_HEADERS.has(lower)) return;
        res.setHeader(key, value);
      });

      const payload = Buffer.from(await upstream.arrayBuffer());
      res.end(payload);
    },
  };
}
