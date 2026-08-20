// SPDX-License-Identifier: LicenseRef-OpenLBM-Community-Source-1.0
// SPDX-FileCopyrightText: 2026 FutureBuild, Inc. and OpenLBM contributors
import { rmSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createAdminHandler } from '../admin-api';
import {
  ADMIN_DATA_DIR,
  consumeDailyQuota,
  readStoredKey,
  usageDay,
  usageToday,
} from '../admin-store';

/**
 * The admin API, driven over a real socket.
 *
 * This endpoint accepts and stores an API key, so most of these are refusal
 * tests: no token, wrong token, remote caller, and — the one that matters
 * most — that no route anywhere returns the stored key.
 */

const TOKEN = 'test-admin-token-0123456789';
const KEY = 'sk-ant-api03-adminadminadminadminadmin';

interface Harness {
  url: string;
  close: () => Promise<void>;
  upstreamCalls: number;
}

function serve(
  options: { token?: string | undefined; upstreamStatus?: number; allowRemote?: boolean } = {},
): Promise<Harness> {
  // Note: an explicit `undefined` must mean "no token configured", which a
  // default parameter would quietly override — that mistake made the
  // fails-closed test pass against the wrong setup.
  const token = 'token' in options ? options.token : TOKEN;
  const upstreamStatus = options.upstreamStatus ?? 200;
  const allowRemote = options.allowRemote ?? false;
  const state = { upstreamCalls: 0 };
  const fetchImpl = (async () => {
    state.upstreamCalls += 1;
    return new Response('{}', { status: upstreamStatus });
  }) as unknown as typeof fetch;

  const handler = createAdminHandler({ token, allowRemote, fetchImpl });
  const server = http.createServer((req, res) => void handler(req, res, req.url ?? ''));

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}`,
        get upstreamCalls() {
          return state.upstreamCalls;
        },
        close: () => new Promise((done) => server.close(() => done())),
      } as Harness);
    });
  });
}

let harness: Harness | null = null;

const TODAY = '2026-08-05';

beforeEach(() => {
  rmSync(ADMIN_DATA_DIR, { recursive: true, force: true });
});
afterEach(async () => {
  await harness?.close();
  harness = null;
  rmSync(ADMIN_DATA_DIR, { recursive: true, force: true });
});

async function call(
  url: string,
  path: string,
  init: RequestInit & { token?: string | null } = {},
): Promise<{ status: number; body: string }> {
  const { token = TOKEN, ...rest } = init;
  const response = await fetch(`${url}${path}`, {
    ...rest,
    headers: {
      'content-type': 'application/json',
      ...(token ? { 'x-admin-token': token } : {}),
      ...(rest.headers as Record<string, string>),
    },
  });
  return { status: response.status, body: await response.text() };
}

/** The current config fingerprint — every write has to present it. */
async function revision(url: string): Promise<string> {
  const state = await call(url, '/state');
  return JSON.parse(state.body).revision as string;
}

/** A config write that plays by the rules, so tests assert on the payload. */
async function putConfig(url: string, config: unknown, rev?: string) {
  return call(url, '/config', {
    method: 'PUT',
    body: typeof config === 'string' ? config : JSON.stringify(config),
    headers: { 'if-match': rev ?? (await revision(url)) },
  });
}

describe('the gate', () => {
  it('refuses everything when no token is configured — never defaults to open', async () => {
    harness = await serve({ token: undefined });
    const result = await call(harness.url, '/state', { method: 'GET', token: null });
    expect(result.status).toBe(503);
    expect(result.body).toContain('disabled');
  });

  it('refuses a missing or wrong token', async () => {
    harness = await serve({});
    expect((await call(harness.url, '/state', { method: 'GET', token: null })).status).toBe(401);
    expect((await call(harness.url, '/state', { method: 'GET', token: 'nope' })).status).toBe(401);
    // A token of the right length but wrong content must also fail.
    expect(
      (await call(harness.url, '/state', { method: 'GET', token: 'x'.repeat(TOKEN.length) }))
        .status,
    ).toBe(401);
  });

  it('lets a correct token through', async () => {
    harness = await serve({});
    const result = await call(harness.url, '/state', { method: 'GET' });
    expect(result.status).toBe(200);
  });
});

describe('the credential', () => {
  it('stores a key that Anthropic accepts', async () => {
    harness = await serve({ upstreamStatus: 200 });
    const result = await call(harness.url, '/credential', {
      method: 'PUT',
      body: JSON.stringify({ key: KEY }),
    });

    expect(result.status).toBe(200);
    expect(harness.upstreamCalls).toBe(1); // validated before storing
    expect(readStoredKey()).toBe(KEY);
  });

  it('refuses a key Anthropic rejects, and stores nothing', async () => {
    harness = await serve({ upstreamStatus: 401 });
    const result = await call(harness.url, '/credential', {
      method: 'PUT',
      body: JSON.stringify({ key: KEY }),
    });

    expect(result.status).toBe(400);
    expect(readStoredKey()).toBeUndefined();
  });

  it('refuses a malformed key without calling upstream or echoing it', async () => {
    harness = await serve({});
    const result = await call(harness.url, '/credential', {
      method: 'PUT',
      body: JSON.stringify({ key: 'hunter2-super-secret' }),
    });

    expect(result.status).toBe(400);
    expect(harness.upstreamCalls).toBe(0);
    expect(result.body).not.toContain('hunter2');
    expect(readStoredKey()).toBeUndefined();
  });

  /** The property the whole design rests on. */
  it('never returns the stored key from ANY route', async () => {
    harness = await serve({ upstreamStatus: 200 });
    await call(harness.url, '/credential', { method: 'PUT', body: JSON.stringify({ key: KEY }) });

    for (const path of ['/state', '/config', '/credential', '/', '/../secrets.json']) {
      const result = await call(harness.url, path, { method: 'GET' });
      expect(result.body, path).not.toContain(KEY);
      // Not even a suffix long enough to be useful.
      expect(result.body, path).not.toContain(KEY.slice(-12));
    }
  });

  it('reports presence and a mask, and the mask is not a usable key', async () => {
    harness = await serve({ upstreamStatus: 200 });
    const result = await call(harness.url, '/credential', {
      method: 'PUT',
      body: JSON.stringify({ key: KEY }),
    });

    const state = JSON.parse(result.body);
    expect(state.credential.present).toBe(true);
    expect(state.credential.masked).toContain('…');
    expect(state.credential.masked).not.toBe(KEY);
  });

  it('removes the key on request', async () => {
    harness = await serve({ upstreamStatus: 200 });
    await call(harness.url, '/credential', { method: 'PUT', body: JSON.stringify({ key: KEY }) });
    const result = await call(harness.url, '/credential', { method: 'DELETE' });

    expect(result.status).toBe(200);
    expect(readStoredKey()).toBeUndefined();
    expect(JSON.parse(result.body).credential.present).toBe(false);
  });
});

describe('config writes', () => {
  it('persists a valid config and hands back the new state', async () => {
    harness = await serve({});
    const result = await putConfig(harness.url, {
      branding: { companyName: 'Cascade Building Supply', brandColor: '#1E40AF' },
      features: { payments: false },
    });

    expect(result.status).toBe(200);
    const state = JSON.parse(result.body);
    expect(state.config.branding.companyName).toBe('Cascade Building Supply');
    expect(state.config.features.payments).toBe(false);
    expect(state.config.features.assistant).toBe(true); // untouched flags survive
  });

  it('never stores a CSS-injection colour, and keeps the rest of the config', async () => {
    harness = await serve({});
    const result = await putConfig(harness.url, {
      branding: {
        companyName: 'Cascade Supply',
        brandColor: 'red; } body { display:none } .x {',
      },
      features: { payments: false },
    });

    expect(result.status).toBe(200);
    expect(result.body).not.toContain('display:none');
    const state = JSON.parse(result.body);
    // The bad colour costs the colour; nothing else is lost.
    expect(state.config.branding.companyName).toBe('Cascade Supply');
    expect(state.config.features.payments).toBe(false);
  });

  it('refuses malformed JSON without leaking a stack trace', async () => {
    harness = await serve({});
    const result = await putConfig(harness.url, '{ not json');
    expect(result.status).toBe(400);
    expect(result.body).not.toContain('SyntaxError');
    expect(result.body).not.toContain('.ts:');
    expect(result.body).not.toContain('node_modules');
  });
});

describe('two admins editing at once', () => {
  it('refuses a write built on a config someone else already replaced', async () => {
    harness = await serve({});
    // Both consoles load the same state.
    const shared = await revision(harness.url);

    const first = await putConfig(harness.url, { branding: { companyName: 'First Wins' } }, shared);
    expect(first.status).toBe(200);

    // The second admin saves the form they loaded before that happened.
    const second = await putConfig(
      harness.url,
      { branding: { companyName: 'Silently Clobbers' } },
      shared,
    );

    expect(second.status).toBe(409);
    expect(JSON.parse(second.body).error.message).toMatch(/changed somewhere else/i);

    // And the first admin's change is still there.
    const state = await call(harness.url, '/state');
    expect(JSON.parse(state.body).config.branding.companyName).toBe('First Wins');
  });

  it('refuses a write that presents no revision at all', async () => {
    harness = await serve({});
    const result = await call(harness.url, '/config', {
      method: 'PUT',
      body: JSON.stringify({ branding: { companyName: 'No Preconditions' } }),
    });

    expect(result.status).toBe(409);
    const state = await call(harness.url, '/state');
    expect(JSON.parse(state.body).config.branding.companyName).not.toBe('No Preconditions');
  });

  it('hands back a revision that changes with the config and is stable without it', async () => {
    harness = await serve({});
    const before = await revision(harness.url);
    expect(await revision(harness.url)).toBe(before);

    await putConfig(harness.url, { branding: { companyName: 'Moved' } }, before);
    expect(await revision(harness.url)).not.toBe(before);
  });
});

describe('assistant usage is attributed to a contractor', () => {
  it('counts per account and reports the busiest first', () => {
    consumeDailyQuota(0, TODAY, 'acct_summit');
    consumeDailyQuota(0, TODAY, 'acct_summit');
    consumeDailyQuota(0, TODAY, 'acct_ridge');

    const usage = usageToday(TODAY);
    expect(usage.total).toBe(3);
    expect(usage.byAccount).toEqual([
      { accountId: 'acct_summit', count: 2 },
      { accountId: 'acct_ridge', count: 1 },
    ]);
  });

  /**
   * The cap is per account. A shared counter let one busy crew lock every
   * other contractor out of the assistant for the rest of the day, which is
   * not what a dealer means when they set "requests per day".
   */
  it('caps each account separately', () => {
    expect(consumeDailyQuota(2, TODAY, 'acct_summit')).toBe(true);
    expect(consumeDailyQuota(2, TODAY, 'acct_summit')).toBe(true);
    expect(consumeDailyQuota(2, TODAY, 'acct_summit')).toBe(false);

    // A different contractor is unaffected by the first one's spending.
    expect(consumeDailyQuota(2, TODAY, 'acct_ridge')).toBe(true);
  });

  /**
   * The id arrives in a request header and becomes a key written to disk.
   * Unknown shapes must collapse into one bucket rather than being dropped —
   * a dealer needs to SEE unattributed spend, it is the case worth noticing.
   */
  it('buckets a hostile or absent account id instead of trusting it', () => {
    consumeDailyQuota(0, TODAY, '../../etc/passwd');
    consumeDailyQuota(0, TODAY, '__proto__');
    consumeDailyQuota(0, TODAY, undefined);
    consumeDailyQuota(0, TODAY, 'x'.repeat(500));

    const usage = usageToday(TODAY);
    expect(usage.total).toBe(4);
    expect(usage.byAccount).toEqual([{ accountId: 'unattributed', count: 4 }]);
    expect(Object.keys({}).length).toBe(0); // prototype untouched
  });

  it('starts a new day clean', () => {
    consumeDailyQuota(0, TODAY, 'acct_summit');
    expect(usageToday('2099-01-01')).toEqual({ total: 0, byAccount: [] });
  });
});

describe('a "daily" cap means the dealer\'s day', () => {
  /**
   * It used to be the UTC day. West of Greenwich that resets in the afternoon
   * or evening — the cap lifted while the yard was still open, so a contractor
   * capped at lunchtime got a fresh allowance over dinner.
   */
  it('rolls over on the local day, not UTC', () => {
    const lateEvening = new Date(2026, 7, 5, 23, 30, 0);
    expect(usageDay(lateEvening)).toBe('2026-08-05');
    expect(lateEvening.toISOString().slice(0, 10)).not.toBe(usageDay(lateEvening));
  });

  it('formats as YYYY-MM-DD so it sorts and compares as a string', () => {
    expect(usageDay(new Date(2026, 0, 9, 12, 0, 0))).toBe('2026-01-09');
  });
});
