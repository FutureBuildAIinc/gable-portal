// SPDX-License-Identifier: LicenseRef-OpenLBM-Community-Source-1.0
// SPDX-FileCopyrightText: 2026 FutureBuild, Inc. and OpenLBM contributors
/**
 * Streaming passthrough to the Anthropic Messages API.
 *
 * Two ways a request gets a key, in precedence order:
 *
 * 1. **The dealer's key**, configured once in the admin console.
 *    A developer pastes their own key in the UI; it rides same-origin to here
 *    and no further. Routing BYOK through the proxy rather than letting the
 *    browser call Anthropic directly is the point — the model allowlist, the
 *    max_tokens ceiling, the rate limit, and abort propagation all still apply
 *    to a request the user paid for.
 * 2. **The server's own ANTHROPIC_API_KEY**, which never reaches the browser.
 *    The client sends a placeholder in `x-api-key`; this swaps in the real one.
 *
 * Either way the SSE bytes are piped straight back. A forwarded key is used
 * for exactly one upstream call and is never stored, echoed, or logged.
 *
 * `proxyClaude` is deliberately host-agnostic — it takes a body and a key and
 * returns a web `Response`, so any runtime (Node, edge, worker) can wrap it.
 * It now has two callers: the Vite dev middleware below, and the production
 * host in `server/serve.ts` (a plain `http.createServer`, chosen in M9 —
 * explicitly not Vercel). Keep it host-agnostic anyway. That property is the
 * reason `serve.ts` could stay small enough to review, and the reason the two
 * hosts cannot drift apart on the security-relevant paths.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Plugin } from 'vite';
import { consumeDailyQuota, readConfig, readStoredKey, usageDay } from './admin-store';
import { mountApiBehindHostCheck } from './dev-middleware';

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';

/**
 * Same-origin only. The endpoint spends the server's API key, so a page on any
 * other origin must not be able to drive it with the visitor's browser as the
 * confused deputy. A same-origin fetch either omits Origin or sends its own
 * host; anything else is refused.
 */
function crossOrigin(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (!origin) return false;
  try {
    return new URL(origin).host !== req.headers.host;
  } catch {
    return true;
  }
}

/**
 * Token bucket per client address — a leaked dev URL should not become a free
 * relay that drains the key's quota. Generous for one human, hostile to a loop.
 */
const RATE_LIMIT = { capacity: 20, refillPerSecond: 0.5 };
const buckets = new Map<string, { tokens: number; lastRefill: number }>();

function allowRequest(clientKey: string): boolean {
  const now = Date.now();
  const bucket = buckets.get(clientKey) ?? { tokens: RATE_LIMIT.capacity, lastRefill: now };
  bucket.tokens = Math.min(
    RATE_LIMIT.capacity,
    bucket.tokens + ((now - bucket.lastRefill) / 1000) * RATE_LIMIT.refillPerSecond,
  );
  bucket.lastRefill = now;
  if (bucket.tokens < 1) {
    buckets.set(clientKey, bucket);
    return false;
  }
  bucket.tokens -= 1;
  buckets.set(clientKey, bucket);
  return true;
}

/** Shape check, so a malformed key is rejected here rather than forwarded
 *  upstream as somebody's typo. */
function wellFormedKey(value: unknown): value is string {
  return typeof value === 'string' && /^sk-ant-[A-Za-z0-9_-]{16,}$/.test(value.trim());
}

/**
 * The key this request should spend.
 *
 * There is no longer a contractor-supplied key. The credential belongs to the
 * DEALER: they configure it once in the admin console, they unlock the
 * assistant feature, and they carry the bill — which is why usage is now
 * counted per contractor account and shown to them.
 *
 * A browser-held key was right while this was a developer tool. It is wrong
 * for a deployed product: it puts a credential in every contractor's
 * localStorage, spreads the blast radius of a leak across every device, and
 * leaves the dealer unable to see or cap what is spent in their name.
 */
export function resolveKey(
  serverKey: string | undefined,
  /** The dealer admin's stored key, if one has been configured. */
  dealerKey?: string | undefined,
): { key: string; source: 'dealer' | 'server' } | null {
  // The dealer's configured key beats a stale environment variable nobody
  // remembers setting.
  if (wellFormedKey(dealerKey)) return { key: dealerKey.trim(), source: 'dealer' };
  if (serverKey) return { key: serverKey, source: 'server' };
  return null;
}

/** Only models we actually use — keeps a leaked proxy from becoming an open relay. */
const ALLOWED_MODELS = new Set(['claude-opus-4-8', 'claude-haiku-4-5']);
/** Streaming is used throughout, so the ceiling can be generous. */
const MAX_TOKENS_CEILING = 32_000;

export interface ProxyRequestBody {
  model?: unknown;
  max_tokens?: unknown;
  [key: string]: unknown;
}

export function validateRequest(body: ProxyRequestBody): string | null {
  if (typeof body.model !== 'string' || !ALLOWED_MODELS.has(body.model)) {
    return `model must be one of: ${[...ALLOWED_MODELS].join(', ')}`;
  }
  // Integer, because the API rejects a fractional max_tokens — and a hand
  // edited config is a caller too.
  if (
    typeof body.max_tokens !== 'number' ||
    !Number.isInteger(body.max_tokens) ||
    body.max_tokens < 1 ||
    body.max_tokens > MAX_TOKENS_CEILING
  ) {
    return `max_tokens must be a whole number between 1 and ${MAX_TOKENS_CEILING}`;
  }
  return null;
}

/** Shared by dev middleware and the serverless twin. */
export async function proxyClaude(
  body: ProxyRequestBody,
  apiKey: string,
  signal?: AbortSignal,
  /** Injectable transport, so the streaming path can be tested without a key. */
  fetchImpl: typeof fetch = fetch,
): Promise<Response> {
  const invalid = validateRequest(body);
  if (invalid) {
    return new Response(JSON.stringify({ error: { message: invalid } }), {
      status: 400,
      headers: { 'content-type': 'application/json' },
    });
  }

  return fetchImpl(ANTHROPIC_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': ANTHROPIC_VERSION,
    },
    body: JSON.stringify(body),
    ...(signal ? { signal } : {}),
  });
}

/**
 * Generous enough for the base64 photo and PDF attachments the assistant
 * sends, small enough that a chunked upload cannot exhaust the dev server's
 * heap. The rate limiter charges one token per REQUEST, so without a byte cap
 * a single request could stream gigabytes for free.
 */
const MAX_BODY_BYTES = 12 * 1024 * 1024;

class BodyTooLarge extends Error {}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;

    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        // Pause rather than destroy: destroying here resets the socket before
        // the 413 can be written, and the caller gets ECONNRESET instead of
        // being told what was wrong. The handler answers, then hangs up.
        req.pause();
        reject(new BodyTooLarge());
        return;
      }
      chunks.push(chunk);
    });
    // Concatenated once at the end so a multi-byte character split across a
    // chunk boundary decodes correctly.
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(payload));
}

/**
 * The `/v1/messages` handler, extracted from the plugin so it can be mounted
 * on a plain http server in a test. That seam exists because the plugin form
 * hid a total outage: the endpoint aborted every upstream call and nothing
 * covered it, since the session tests inject their own fetch.
 */
/**
 * Which contractor account a request is spent on. Advisory: it identifies the
 * spender for the dealer's console, it does not authorise anything.
 */
export const ACCOUNT_HEADER = 'x-gn-account';

/** Node lower-cases header names, and repeats arrive as an array. */
function header(req: IncomingMessage, name: string): string | undefined {
  const raw = req.headers[name];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return value?.trim() || undefined;
}

export interface MessagesHandlerDeps {
  fetchImpl?: typeof fetch;
  /**
   * The dealer-configured key. Injected rather than read ambiently: reading
   * the admin store's file straight from this handler coupled it to whatever
   * another test suite had left on disk, and the two suites went flaky against
   * each other through the dealer > server precedence.
   */
  dealerKey?: () => string | undefined;
  /**
   * Charging one request against the daily cap. Injected for the same reason
   * as `dealerKey`: this now writes on EVERY proxied request, so leaving it
   * ambient put a disk write into the request path of a suite that shares the
   * data directory with the admin tests — and they immediately went flaky
   * against each other, a different test failing each run.
   */
  consumeQuota?: (cap: number, today: string, accountId?: string) => boolean;
  /** The configured cap. Same isolation argument. */
  readCap?: () => number;
}

export function createMessagesHandler(apiKey: string | undefined, deps: MessagesHandlerDeps = {}) {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const dealerKey = deps.dealerKey ?? readStoredKey;
  const consumeQuota = deps.consumeQuota ?? consumeDailyQuota;
  const readCap = deps.readCap ?? (() => readConfig().assistant.dailyRequestCap);

  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    {
      const response = res as ServerResponse;

      if (req.method !== 'POST') {
        sendJson(response, 405, { error: { message: 'POST only' } });
        return;
      }
      if (crossOrigin(req)) {
        sendJson(response, 403, { error: { message: 'same-origin requests only' } });
        return;
      }
      if (!allowRequest(req.socket.remoteAddress ?? 'unknown')) {
        sendJson(response, 429, { error: { message: 'Slow down — too many requests.' } });
        return;
      }
      const resolved = resolveKey(apiKey, dealerKey());
      if (!resolved) {
        sendJson(response, 503, {
          error: {
            message:
              'No Anthropic API key. Add your own key in the assistant, or have your administrator set one in the admin console.',
          },
        });
        return;
      }

      // The dealer's daily cap governs the key THEY pay for. A contractor
      // spending their own key is not billed to the dealer, so it does not
      // count against it.
      {
        // Wrapped: a full disk or a read-only mount must not escape this async
        // middleware — an unhandled rejection there hangs the request and can
        // take the dev server with it. A cap that cannot be read fails open.
        let overCap = false;
        try {
          /**
           * Attribution, NOT authorization. The account id comes from the
           * client, so a caller could claim someone else's. It is here so a
           * dealer can see which contractor is spending their key, and the
           * store bounds what it will write. Real per-tenant enforcement needs
           * authenticated sessions, which this demo does not have — do not
           * mistake this counter for a security control.
           */
          const accountId = header(req, ACCOUNT_HEADER);
          overCap = !consumeQuota(readCap(), usageDay(), accountId);
        } catch (error) {
          console.error('[proxy] daily cap could not be evaluated; allowing', error);
        }
        if (overCap) {
          sendJson(response, 429, {
            error: {
              message:
                'This deployment has reached its daily assistant limit. It resets tomorrow, or you can add your own API key to keep going.',
            },
          });
          return;
        }
      }

      // When the browser walks away (assistant Stop button, closed tab),
      // stop paying for tokens nobody will read.
      //
      // This listens on the RESPONSE, not the request. Since Node 16 an
      // IncomingMessage emits 'close' when the request MESSAGE COMPLETES,
      // not only when the client disconnects — and because the nextTick
      // queue drains before microtasks, that fired before the awaited
      // readBody continuation. The signal was therefore already aborted at
      // every fetch, which took the whole endpoint down. ServerResponse
      // 'close' is the real disconnect signal; writableEnded distinguishes
      // a normal finish from a hang-up.
      const abort = new AbortController();
      response.on('close', () => {
        if (!response.writableEnded) abort.abort();
      });

      try {
        const body = JSON.parse(await readBody(req)) as ProxyRequestBody;
        const upstream = await proxyClaude(body, resolved.key, abort.signal, fetchImpl);

        response.statusCode = upstream.status;
        response.setHeader(
          'content-type',
          upstream.headers.get('content-type') ?? 'application/json',
        );
        // Defeat proxy buffering so tokens arrive as they stream.
        response.setHeader('cache-control', 'no-cache, no-transform');

        if (!upstream.body) {
          response.end();
          return;
        }
        const reader = upstream.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          response.write(value);
        }
        response.end();
      } catch (error) {
        if (error instanceof BodyTooLarge) {
          // Answer first, then stop the upload still arriving behind it.
          response.on('finish', () => req.destroy());
          sendJson(response, 413, { error: { message: 'Request body is too large.' } });
          return;
        }
        if (abort.signal.aborted) {
          // The client hung up; there is nobody to answer.
          response.destroy();
          return;
        }
        // Headers may already be on the wire mid-stream; sendJson would then
        // throw inside this catch and take the dev server down with it.
        if (response.headersSent) {
          response.destroy();
          return;
        }
        sendJson(response, 502, {
          error: { message: error instanceof Error ? error.message : 'proxy failure' },
        });
      }
    }
  };
}

/**
 * Vite dev middleware. `apiKey` comes from vite.config.ts via loadEnv, so it
 * stays in the Node process and never enters the client bundle.
 */
/**
 * `dealerKey` is injectable for the same reason it is on the messages handler:
 * reading the admin store's file straight from the health route couples this
 * plugin to whatever another test suite has left on disk. The admin suite
 * writes a credential, the health route read it ambiently, and the dev-server
 * test then saw `hasKey: true` — passing alone and failing in a full run. That
 * exact coupling was fixed once already, on the handler next door.
 */
export function claudeProxyPlugin(
  apiKey: string | undefined,
  deps: { dealerKey?: () => string | undefined } = {},
): Plugin {
  const dealerKey = deps.dealerKey ?? readStoredKey;
  return {
    name: 'gablenow-claude-proxy',
    configureServer(server) {
      // Registered from the RETURNED function, not the hook body, and then
      // RELOCATED — see server/dev-middleware.ts. The post-hook alone puts
      // these behind the HTML fallback, which rewrites the URL and swallows
      // every request a browser sends with its default `Accept`.
      //
      // Vite installs its own hostCheckMiddleware — the DNS-rebinding defence —
      // only AFTER configureServer hooks run, so middleware added synchronously
      // here sits IN FRONT of it. That let a page which rebound to 127.0.0.1
      // reach this key-spending endpoint as same-origin, and `crossOrigin()`
      // could not catch it: it compares Origin against the client-supplied Host
      // header, and under rebinding those match. Verified before the fix —
      // `Host: evil.com` was 403 on `/` and 200 here. Post-hooks run behind
      // the host check, so Vite's allowedHosts now governs these routes too.
      return () => {
        // The client checks this once at boot to decide whether to render the
        // assistant or a "set your key" state. Never returns the key itself.
        server.middlewares.use('/api/anthropic/health', (_req, res) => {
          // Counts the dealer's admin-configured key as well as the environment
          // one. Reporting only on `apiKey` meant a dealer who set a key in the
          // console — validated, paid for, working — still saw the assistant
          // render disabled.
          //
          // Deliberately still just a boolean: this route is unauthenticated, so
          // it discloses that a key exists and nothing whatsoever about it.
          sendJson(res as ServerResponse, 200, {
            ok: true,
            hasKey: Boolean(apiKey || dealerKey()),
          });
        });

        server.middlewares.use('/api/anthropic/v1/messages', createMessagesHandler(apiKey));

        mountApiBehindHostCheck(server, ['/api/anthropic/health', '/api/anthropic/v1/messages']);
      };
    },
  };
}
