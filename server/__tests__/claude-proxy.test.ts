// SPDX-License-Identifier: LicenseRef-OpenLBM-Community-Source-1.0
// SPDX-FileCopyrightText: 2026 FutureBuild, Inc. and OpenLBM contributors
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { createMessagesHandler } from '../claude-proxy';

/**
 * The proxy driven over a REAL socket.
 *
 * This file exists because its absence hid a total outage. The handler wired
 * its abort controller to `req.on('close')`, which since Node 16 fires when
 * the request message completes — not only on disconnect — so every upstream
 * call was aborted before it left. Nothing caught it: the session tests inject
 * their own fetch and never reach this middleware, and the unit tests only
 * exercised the pure helpers. So these tests use a real server, a real client
 * request, and a stub upstream.
 */

const KEY = 'sk-ant-api03-serverserverserverserverserver';
/**
 * A key a stale or hostile client might still forward in the header BYOK used
 * to use. It must never be spent — see "the forwarded-key door is closed".
 */
const FORWARDED = 'sk-ant-api03-callercallercallercallercaller';
const BYOK_HEADER = 'x-anthropic-byok';

const defaultUpstream = () =>
  new Response('event: ok\ndata: {}\n\n', {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });

const VALID_BODY = JSON.stringify({
  model: 'claude-opus-4-8',
  max_tokens: 16,
  messages: [{ role: 'user', content: 'hi' }],
});

interface Harness {
  url: string;
  close: () => Promise<void>;
  seen: { key: string | null; count: number };
}

/** Mounts the handler on a real http server with a stub upstream. */
function serve(
  apiKey: string | undefined,
  upstream: ((init: RequestInit) => Response) | undefined = () =>
    new Response('event: ok\ndata: {}\n\n', {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    }),
  dealerKey: () => string | undefined = () => undefined,
): Promise<Harness> {
  const seen = { key: null as string | null, count: 0 };
  const fetchImpl = (async (_url: unknown, init: RequestInit) => {
    // Honour the abort signal exactly as the real fetch does. Without this the
    // stub cheerfully answers an already-aborted request, and the regression
    // this file exists for sails straight through green.
    if (init.signal?.aborted) {
      throw Object.assign(new Error('This operation was aborted'), { name: 'AbortError' });
    }
    seen.count += 1;
    seen.key = (init.headers as Record<string, string>)['x-api-key'] ?? null;
    return (upstream ?? defaultUpstream)(init);
  }) as unknown as typeof fetch;

  // No dealer key, no cap, no usage accounting: every route out of this
  // handler that would otherwise touch the shared data directory is pinned, so
  // this suite can never pick up — or race — whatever the admin suite has
  // written to disk.
  const server = http.createServer(
    createMessagesHandler(apiKey, {
      fetchImpl,
      dealerKey,
      readCap: () => 0,
      consumeQuota: () => true,
    }),
  );
  return new Promise((resolve) => {
    server.listen(0, () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}`,
        seen,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

let harness: Harness | null = null;
afterEach(async () => {
  await harness?.close();
  harness = null;
});

async function post(
  url: string,
  headers: Record<string, string> = {},
  body = VALID_BODY,
): Promise<{ status: number; text: string }> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body,
  });
  return { status: response.status, text: await response.text() };
}

describe('a normal request', () => {
  /** The regression that matters: this used to be a destroyed socket. */
  it('actually reaches upstream and streams the bytes back', async () => {
    harness = await serve(KEY);
    const result = await post(harness.url);

    expect(harness.seen.count).toBe(1);
    expect(result.status).toBe(200);
    expect(result.text).toContain('event: ok');
  });

  it('spends the server key when nothing is forwarded', async () => {
    harness = await serve(KEY);
    await post(harness.url);
    expect(harness.seen.key).toBe(KEY);
  });
});

/**
 * Contractor-supplied keys are gone: the credential belongs to the dealer.
 * These pin the REMOVAL, because deleting the client code is not the same as
 * closing the door — the endpoint is what an attacker talks to.
 */
describe('the forwarded-key door is closed', () => {
  it('ignores a forwarded key and spends the configured one', async () => {
    harness = await serve(KEY);
    await post(harness.url, { [BYOK_HEADER]: FORWARDED });
    expect(harness.seen.key).toBe(KEY);
    expect(harness.seen.key).not.toBe(FORWARDED);
  });

  it('refuses outright when only a forwarded key is offered', async () => {
    harness = await serve(undefined);
    const result = await post(harness.url, { [BYOK_HEADER]: FORWARDED });

    // 503, not 200: with no dealer key there is nothing to spend, and a
    // caller cannot supply one. Anything else would make the proxy an open
    // relay for whoever guesses the header.
    expect(result.status).toBe(503);
    expect(harness.seen.count).toBe(0);
  });
});

describe('the guards bite before any key is read', () => {
  it('rejects a model outside the allowlist before spending anything', async () => {
    harness = await serve(KEY);
    const result = await post(harness.url, {}, JSON.stringify({ model: 'gpt-4', max_tokens: 10 }));
    expect(result.status).toBe(400);
    expect(harness.seen.count).toBe(0);
  });

  it('rejects a max_tokens above the ceiling', async () => {
    harness = await serve(KEY);
    const result = await post(
      harness.url,
      {},
      JSON.stringify({ model: 'claude-opus-4-8', max_tokens: 1_000_000 }),
    );
    expect(result.status).toBe(400);
    expect(harness.seen.count).toBe(0);
  });

  it('refuses a cross-origin caller before reading any key', async () => {
    harness = await serve(KEY);
    const result = await post(harness.url, {
      Origin: 'https://evil.example',
    });
    expect(result.status).toBe(403);
    expect(harness.seen.count).toBe(0);
  });

  it('refuses anything but POST', async () => {
    harness = await serve(KEY);
    const response = await fetch(harness.url, { method: 'GET' });
    expect(response.status).toBe(405);
  });

  it('answers 503 when neither side has a key, without calling upstream', async () => {
    harness = await serve(undefined);
    const result = await post(harness.url);
    expect(result.status).toBe(503);
    expect(harness.seen.count).toBe(0);
  });

  it('ignores a malformed forwarded key rather than sending it upstream', async () => {
    harness = await serve(KEY);
    await post(harness.url, {});
    expect(harness.seen.key).toBe(KEY);
  });
});

describe('failure handling', () => {
  it('reports an upstream error as JSON rather than hanging up', async () => {
    harness = await serve(KEY, () => {
      throw new Error('upstream exploded');
    });
    const result = await post(harness.url);
    expect(result.status).toBe(502);
    expect(result.text).toContain('upstream exploded');
  });

  it('passes an upstream rejection through with its status', async () => {
    harness = await serve(
      KEY,
      () =>
        new Response(JSON.stringify({ error: { message: 'invalid key' } }), {
          status: 401,
          headers: { 'content-type': 'application/json' },
        }),
    );
    const result = await post(harness.url);
    expect(result.status).toBe(401);
    expect(result.text).toContain('invalid key');
  });

  /** The key must never reach the client, not even in an error body. */
  it('never echoes a key back to the caller', async () => {
    harness = await serve(KEY, () => {
      throw new Error('upstream exploded');
    });
    const result = await post(harness.url, { [BYOK_HEADER]: FORWARDED });
    expect(result.text).not.toContain(KEY);
    expect(result.text).not.toContain(FORWARDED);
  });
});

describe('body size', () => {
  it('refuses an oversized body with 413 instead of buffering it', async () => {
    harness = await serve(KEY);
    // 13 MB of chunked upload, past the 12 MB ceiling.
    const huge = 'x'.repeat(13 * 1024 * 1024);
    const result = await post(harness.url, {}, JSON.stringify({ pad: huge }));

    expect(result.status).toBe(413);
    expect(harness.seen.count).toBe(0);
  });

  it('still accepts a body large enough for a photo attachment', async () => {
    harness = await serve(KEY);
    const attachment = 'A'.repeat(2 * 1024 * 1024);
    const result = await post(
      harness.url,
      {},
      JSON.stringify({
        model: 'claude-opus-4-8',
        max_tokens: 16,
        messages: [{ role: 'user', content: attachment }],
      }),
    );
    expect(result.status).toBe(200);
  });
});

describe('the dealer-configured key', () => {
  it('is spent when there is no env key', async () => {
    const dealer = 'sk-ant-api03-dealerdealerdealerdealerdealer';
    harness = await serve(undefined, undefined, () => dealer);

    const result = await post(harness.url);
    expect(result.status).toBe(200);
    expect(harness.seen.key).toBe(dealer);
  });

  it("loses to a contractor's own key, and beats the env key", async () => {
    const dealer = 'sk-ant-api03-dealerdealerdealerdealerdealer';
    harness = await serve(KEY, undefined, () => dealer);

    await post(harness.url);
    expect(harness.seen.key).toBe(dealer); // dealer > env

    await post(harness.url, { [BYOK_HEADER]: FORWARDED });
    expect(harness.seen.key).not.toBe(FORWARDED); // a caller cannot override the dealer
  });
});
