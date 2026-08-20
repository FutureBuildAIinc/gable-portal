// SPDX-License-Identifier: LicenseRef-OpenLBM-Community-Source-1.0
// SPDX-FileCopyrightText: 2026 FutureBuild, Inc. and OpenLBM contributors
import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { parseConfig } from '../src/core/domain/config';
import {
  clearStoredKey,
  configRevision,
  maskedKey,
  readConfig,
  storeKey,
  usageDay,
  usageToday,
  writeConfig,
} from './admin-store';

/**
 * The dealer admin API.
 *
 * This endpoint ACCEPTS A CREDENTIAL, which sets the bar for everything here:
 *
 * - **Write-only secrets.** There is no route that returns the stored key.
 *   The admin UI gets `hasCredential` and a mask, and that is all that exists.
 * - **The token is compared in constant time**, and a deployment with no token
 *   configured refuses every admin request rather than defaulting to open. An
 *   admin surface that is accidentally public is worse than one that is
 *   accidentally unreachable.
 * - **Loopback only by default.** `vite --host` puts the dev server on the LAN;
 *   the admin routes should not follow it there without a deliberate opt-in.
 * - **The key is validated against Anthropic before it is stored**, so a
 *   dealer cannot save a typo and discover it when a contractor's first
 *   message fails.
 *
 * What this does NOT defend against, stated plainly: anyone who can read the
 * server's environment or its `.gablenow/` directory has the key, and the
 * shared token is a single factor with no per-user identity, no rotation, and
 * no audit trail. It is a development gate. A real deployment needs real
 * accounts, and the upgrade path is to replace `authorize()` alone.
 */

const TOKEN_HEADER = 'x-admin-token';

/** Node lower-cases header names, and repeats arrive as an array. */
function header(req: IncomingMessage, name: string): string {
  const raw = req.headers[name];
  return (Array.isArray(raw) ? raw[0] : raw) ?? '';
}
const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';

export interface AdminOptions {
  /** From GABLENOW_ADMIN_TOKEN. Absent = admin API disabled entirely. */
  token: string | undefined;
  /** GABLENOW_ADMIN_ALLOW_REMOTE=true to permit non-loopback callers. */
  allowRemote?: boolean;
  /** Injectable for tests. */
  fetchImpl?: typeof fetch;
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  // An admin response must never sit in a shared cache.
  res.setHeader('cache-control', 'no-store');
  res.end(JSON.stringify(payload));
}

function isLoopback(req: IncomingMessage): boolean {
  const address = req.socket.remoteAddress ?? '';
  return (
    address === '127.0.0.1' ||
    address === '::1' ||
    address === '::ffff:127.0.0.1' ||
    address.startsWith('127.')
  );
}

/** Constant-time compare, so the token cannot be recovered by timing. */
function tokenMatches(provided: unknown, expected: string): boolean {
  if (typeof provided !== 'string') return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

type AuthFailure = { status: number; message: string };

export function authorize(req: IncomingMessage, options: AdminOptions): AuthFailure | null {
  if (!options.token) {
    return {
      status: 503,
      message:
        'The admin console is disabled. Set GABLENOW_ADMIN_TOKEN in .env and restart the server.',
    };
  }
  if (!options.allowRemote && !isLoopback(req)) {
    return { status: 403, message: 'The admin console is reachable from this machine only.' };
  }
  if (!tokenMatches(req.headers[TOKEN_HEADER], options.token)) {
    return { status: 401, message: 'Wrong admin token.' };
  }
  return null;
}

const MAX_ADMIN_BODY = 2 * 1024 * 1024; // generous for a base64 logo

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_ADMIN_BODY) {
        req.pause();
        reject(new Error('too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/**
 * Confirms a key works before storing it. Uses a 1-token request — the
 * cheapest call that still proves authentication — so a dealer learns about a
 * bad paste immediately rather than through a contractor's failed message.
 */
type KeyCheck = 'ok' | 'rejected' | 'unreachable';

async function keyWorks(key: string, fetchImpl: typeof fetch): Promise<KeyCheck> {
  try {
    const response = await fetchImpl(ANTHROPIC_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': key,
        'anthropic-version': ANTHROPIC_VERSION,
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5',
        max_tokens: 1,
        messages: [{ role: 'user', content: 'hi' }],
      }),
    });
    // Only an explicit success proves the key authenticates. A 429 or a 5xx
    // during an Anthropic incident proves nothing, and storing on "not a 401"
    // would tell the dealer it was checked when it never was.
    if (response.ok) return 'ok';
    if (response.status === 401 || response.status === 403) return 'rejected';
    return 'unreachable';
  } catch {
    return 'unreachable';
  }
}

const KEY_SHAPE = /^sk-ant-[A-Za-z0-9_-]{16,}$/;

/** The admin read model. Constructed field by field so a secret cannot ride along. */
function adminState(today: string) {
  const config = readConfig();
  return {
    config,
    revision: configRevision(config),
    credential: { present: maskedKey() !== null, masked: maskedKey() },
    usage: usageToday(today),
  };
}

export function createAdminHandler(options: AdminOptions) {
  const fetchImpl = options.fetchImpl ?? fetch;

  return async (req: IncomingMessage, res: ServerResponse, url: string): Promise<void> => {
    const denied = authorize(req, options);
    if (denied) {
      sendJson(res, denied.status, { error: { message: denied.message } });
      return;
    }

    const today = usageDay();

    try {
      // GET /api/admin/state — config + whether a credential exists. Never the key.
      if (req.method === 'GET' && url.endsWith('/state')) {
        sendJson(res, 200, adminState(today));
        return;
      }

      // PUT /api/admin/config — replace the public config.
      if (req.method === 'PUT' && url.endsWith('/config')) {
        /**
         * Optimistic concurrency, and it fails closed.
         *
         * The whole config is replaced on every save, so two admins with the
         * screen open silently overwrote each other — the second save simply
         * erased the first, with nothing on screen to suggest it had. A caller
         * that sends no `if-match` cannot have read the current state, so a
         * missing header is refused exactly like a stale one.
         */
        const expected = header(req, 'if-match');
        const actual = configRevision();
        if (expected !== actual) {
          sendJson(res, 409, {
            error: {
              message: expected
                ? 'This configuration changed somewhere else while you were editing. Reload to see the current settings, then re-apply your change.'
                : 'Stale request: reload the console and try again.',
            },
          });
          return;
        }

        const parsed = parseConfig(JSON.parse(await readBody(req)));
        if (!parsed.ok) {
          sendJson(res, 400, { error: { message: parsed.error } });
          return;
        }
        writeConfig(parsed.value);
        sendJson(res, 200, adminState(today));
        return;
      }

      // PUT /api/admin/credential — store a key after proving it works.
      if (req.method === 'PUT' && url.endsWith('/credential')) {
        const body = JSON.parse(await readBody(req)) as { key?: unknown };
        const key = typeof body.key === 'string' ? body.key.trim() : '';

        if (!KEY_SHAPE.test(key)) {
          // Deliberately does not echo what was sent.
          sendJson(res, 400, {
            error: {
              message: 'That does not look like an Anthropic API key (they start sk-ant-).',
            },
          });
          return;
        }
        const checked = await keyWorks(key, fetchImpl);
        if (checked === 'rejected') {
          sendJson(res, 400, {
            error: { message: 'Anthropic rejected that key. Check it and try again.' },
          });
          return;
        }
        if (checked === 'unreachable') {
          // Refusing beats storing an unverified key under a UI that promises
          // it was checked.
          sendJson(res, 503, {
            error: {
              message:
                'Could not reach Anthropic to check that key. Nothing was saved — try again in a moment.',
            },
          });
          return;
        }

        storeKey(key);
        sendJson(res, 200, adminState(today));
        return;
      }

      if (req.method === 'DELETE' && url.endsWith('/credential')) {
        clearStoredKey();
        sendJson(res, 200, adminState(today));
        return;
      }

      sendJson(res, 404, { error: { message: 'No such admin route.' } });
    } catch (error) {
      // Never surface a raw error: this handler has handled a credential, and
      // stack traces have a habit of carrying request bodies with them.
      console.error('[admin] request failed', error instanceof Error ? error.message : error);
      sendJson(res, 400, { error: { message: 'That request could not be processed.' } });
    }
  };
}
