// SPDX-License-Identifier: LicenseRef-OpenLBM-Community-Source-1.0
// SPDX-FileCopyrightText: 2026 FutureBuild, Inc. and OpenLBM contributors
import { describe, expect, it, vi } from 'vitest';
import { createGableClient } from '../client';
import { GableAuthError, GableHttpError, GableNetworkError, GableShapeError } from '../errors';

/**
 * The HTTP client, driven against a stub `fetch`.
 *
 * Every assertion here corresponds to a way this could be wrong in production
 * and be invisible in a demo:
 *
 *  - `credentials: 'include'` missing → every protected call 401s, which reads
 *    on screen as "wrong password" and is actually a fetch option.
 *  - a 401 retried → `gable`'s own client shipped that bug; a re-issued
 *    checkout is a duplicate order in someone's ERP.
 *  - an empty filter sent as `?q=` → `gable` treats it as a real filter term,
 *    so the catalog comes back empty rather than complete.
 *  - a 200 with an unexpected shape read best-effort → `undefined` dollars
 *    become `NaN` cents on a contractor's total.
 *
 * None of these are hypothetical framings; each is the specific reason the
 * corresponding line exists in `client.ts`.
 */

const PRODUCT = {
  id: '8bb239c5-269b-4c57-bf8c-ddc4f168127b',
  sku: 'CORN2006',
  name: 'Flashing J 6 X 6 X 10',
  category: 'Cornice',
  species: '',
  grade: '',
  image_url: '',
  uom: 'EA',
  base_price: 23.25,
  customer_price: 23.24,
  price_source: 'PROMOTIONAL',
  available: 871,
  in_stock: true,
};

interface Call {
  url: string;
  init: RequestInit;
}

function stubFetch(responses: (() => Response)[] | (() => Response)) {
  const calls: Call[] = [];
  let index = 0;
  const impl = vi.fn((url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const next = Array.isArray(responses)
      ? (responses[Math.min(index, responses.length - 1)] ?? responses[0])
      : responses;
    index += 1;
    return Promise.resolve(next?.() ?? new Response('{}', { status: 200 }));
  });
  return { impl: impl as unknown as typeof fetch, calls, count: () => impl.mock.calls.length };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('request shape', () => {
  it('sends the session cookie, because the JWT is httpOnly and unreadable', async () => {
    const fetchStub = stubFetch(() => json([PRODUCT]));
    const client = createGableClient({ baseUrl: '/api/portal/v1', fetchImpl: fetchStub.impl });

    await client.catalog();

    expect(fetchStub.calls[0]?.init.credentials).toBe('include');
  });

  it('joins the base path without doubling or dropping a slash', async () => {
    const fetchStub = stubFetch(() => json([PRODUCT]));
    const client = createGableClient({ baseUrl: '/api/portal/v1/', fetchImpl: fetchStub.impl });

    await client.catalog();

    expect(fetchStub.calls[0]?.url).toBe('/api/portal/v1/catalog');
  });

  it('omits empty filters rather than sending ?q=', async () => {
    const fetchStub = stubFetch(() => json([PRODUCT]));
    const client = createGableClient({ baseUrl: '/api/portal/v1', fetchImpl: fetchStub.impl });

    await client.catalog({ q: '', category: 'Cornice' });

    expect(fetchStub.calls[0]?.url).toBe('/api/portal/v1/catalog?category=Cornice');
  });

  it('percent-encodes a path id so a stray slash cannot escape the route', async () => {
    const fetchStub = stubFetch(() =>
      json({ ...PRODUCT, weight_lbs: 3, upc: '', vendor: 'Kelly-Fradet' }),
    );
    const client = createGableClient({ baseUrl: '/api/portal/v1', fetchImpl: fetchStub.impl });

    await client.catalogProduct('../orders');

    expect(fetchStub.calls[0]?.url).toBe('/api/portal/v1/catalog/..%2Forders');
  });

  it('posts login as the field names gable decodes, not camelCase', async () => {
    const fetchStub = stubFetch(() =>
      json({
        user: {
          id: 'u1',
          customer_id: 'c1',
          email: 'demo@kelbrook.ca',
          name: 'Sam Kelbrook',
          role: 'admin',
          status: 'Active',
        },
        config: {
          id: 'cfg',
          dealer_name: 'Kelly-Fradet',
          logo_url: '',
          primary_color: '#00FFA3',
          support_email: 'a@b.c',
          support_phone: '1',
        },
      }),
    );
    const client = createGableClient({ baseUrl: '/api/portal/v1', fetchImpl: fetchStub.impl });

    const response = await client.login('demo@kelbrook.ca', 'password');

    expect(fetchStub.calls[0]?.init.method).toBe('POST');
    expect(JSON.parse(String(fetchStub.calls[0]?.init.body))).toEqual({
      email: 'demo@kelbrook.ca',
      password: 'password',
    });
    // The token is NOT in the body — it arrives as an httpOnly cookie — so
    // there is nothing here for the client to store, by design.
    expect(response).not.toHaveProperty('token');
    expect(response.config.dealer_name).toBe('Kelly-Fradet');
  });

  it('sends cart quantities under gable field names', async () => {
    const fetchStub = stubFetch(() => json({ id: 'cart', items: [], item_count: 0, subtotal: 0 }));
    const client = createGableClient({ baseUrl: '/api/portal/v1', fetchImpl: fetchStub.impl });

    await client.addCartItem('prod-1', 12);

    expect(JSON.parse(String(fetchStub.calls[0]?.init.body))).toEqual({
      product_id: 'prod-1',
      quantity: 12,
    });
  });
});

describe('auth handling', () => {
  it('throws GableAuthError on 401 and issues exactly one request', async () => {
    const fetchStub = stubFetch(() => json({ error: { message: 'Unauthorized' } }, 401));
    const client = createGableClient({ baseUrl: '/api/portal/v1', fetchImpl: fetchStub.impl });

    await expect(client.catalog()).rejects.toBeInstanceOf(GableAuthError);
    // The whole point. `gable`'s own fetch client once re-issued on 401, which
    // double-posted non-idempotent calls.
    expect(fetchStub.count()).toBe(1);
  });

  it('does not re-issue a checkout on 401 — a duplicate would be a real order', async () => {
    const fetchStub = stubFetch(() => json({ error: { message: 'Unauthorized' } }, 401));
    const client = createGableClient({ baseUrl: '/api/portal/v1', fetchImpl: fetchStub.impl });

    await expect(
      client.checkout({
        delivery_method: 'DELIVERY',
        delivery_address: '',
        payment_method: 'ACCOUNT',
        notes: '',
      }),
    ).rejects.toBeInstanceOf(GableAuthError);
    expect(fetchStub.count()).toBe(1);
  });

  it('does not treat a rejected login as an expiry', async () => {
    // Found in the live transcript: a wrong password said "your session has
    // expired" and fired the expiry handler, tearing down a session that had
    // never existed. On /login a 401 is the expected answer to a normal
    // question, not the end of anything.
    const onUnauthorized = vi.fn();
    const fetchStub = stubFetch(() => json({ error: { message: 'Invalid credentials' } }, 401));
    const client = createGableClient({
      baseUrl: '/api/portal/v1',
      fetchImpl: fetchStub.impl,
      onUnauthorized,
    });

    const error = await client.login('demo@kelbrook.ca', 'wrong').catch((e: unknown) => e);

    expect(error).toBeInstanceOf(GableAuthError);
    expect((error as Error).message).toContain('did not match');
    expect((error as Error).message).not.toContain('expired');
    expect(onUnauthorized).not.toHaveBeenCalled();
  });

  it('calls onUnauthorized once so expiry reaches the UI from one place', async () => {
    const onUnauthorized = vi.fn();
    const fetchStub = stubFetch(() => new Response('', { status: 401 }));
    const client = createGableClient({
      baseUrl: '/api/portal/v1',
      fetchImpl: fetchStub.impl,
      onUnauthorized,
    });

    await expect(client.dashboard()).rejects.toBeInstanceOf(GableAuthError);
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
  });

  it('does not treat a 403 as an expiry — a role refusal is not a bad session', async () => {
    const onUnauthorized = vi.fn();
    const fetchStub = stubFetch(() => json({ error: { message: 'Admin access required' } }, 403));
    const client = createGableClient({
      baseUrl: '/api/portal/v1',
      fetchImpl: fetchStub.impl,
      onUnauthorized,
    });

    await expect(client.catalog()).rejects.toBeInstanceOf(GableHttpError);
    expect(onUnauthorized).not.toHaveBeenCalled();
  });
});

describe('error paths', () => {
  it('carries the status and the ERP’s own message on a non-2xx', async () => {
    const fetchStub = stubFetch(() =>
      json({ error: { code: 'NOT_FOUND', message: 'Product not found' } }, 404),
    );
    const client = createGableClient({ baseUrl: '/api/portal/v1', fetchImpl: fetchStub.impl });

    const error = await client.catalogProduct('missing').catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(GableHttpError);
    expect((error as GableHttpError).status).toBe(404);
    expect((error as GableHttpError).detail).toBe('Product not found');
  });

  it('reports a transport failure as unreachable, not as a bad response', async () => {
    const impl = vi.fn(() => Promise.reject(new TypeError('fetch failed')));
    const client = createGableClient({
      baseUrl: '/api/portal/v1',
      fetchImpl: impl as unknown as typeof fetch,
    });

    await expect(client.catalog()).rejects.toBeInstanceOf(GableNetworkError);
  });

  it('rejects a 200 whose body is not JSON instead of reading it best-effort', async () => {
    const fetchStub = stubFetch(
      () => new Response('<!doctype html><title>login</title>', { status: 200 }),
    );
    const client = createGableClient({ baseUrl: '/api/portal/v1', fetchImpl: fetchStub.impl });

    // This is what a proxy misconfiguration looks like: the SPA fallback
    // answers 200 with HTML and every field silently becomes undefined.
    await expect(client.catalog()).rejects.toBeInstanceOf(GableShapeError);
  });

  it('rejects a 200 that is missing a money field rather than producing NaN', async () => {
    const { customer_price: _dropped, ...withoutPrice } = PRODUCT;
    const fetchStub = stubFetch(() => json([withoutPrice]));
    const client = createGableClient({ baseUrl: '/api/portal/v1', fetchImpl: fetchStub.impl });

    const error = await client.catalog().catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(GableShapeError);
    expect((error as GableShapeError).issues.join(' ')).toContain('customer_price');
  });

  it('accepts a response carrying fields this client does not know about', async () => {
    // Forward compatibility: `gable` adding a column must not break a deployed
    // portal. Removing one still must.
    const fetchStub = stubFetch(() => json([{ ...PRODUCT, future_field: 'whatever' }]));
    const client = createGableClient({ baseUrl: '/api/portal/v1', fetchImpl: fetchStub.impl });

    await expect(client.catalog()).resolves.toHaveLength(1);
  });

  it('accepts a null items array — Go marshals an unallocated slice that way', async () => {
    const fetchStub = stubFetch(() =>
      json({ id: 'cart', items: null, item_count: 0, subtotal: 0 }),
    );
    const client = createGableClient({ baseUrl: '/api/portal/v1', fetchImpl: fetchStub.impl });

    await expect(client.cart()).resolves.toMatchObject({ items: null });
  });

  it('times out rather than hanging the board on an ERP that never answers', async () => {
    const impl = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    );
    const client = createGableClient({
      baseUrl: '/api/portal/v1',
      fetchImpl: impl as unknown as typeof fetch,
      timeoutMs: 10,
    });

    await expect(client.catalog()).rejects.toBeInstanceOf(GableNetworkError);
  });
});
