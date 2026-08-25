// SPDX-License-Identifier: LicenseRef-OpenLBM-Community-Source-1.0
// SPDX-FileCopyrightText: 2026 FutureBuild, Inc. and OpenLBM contributors
import { describe, expect, it, vi } from 'vitest';
import { createGableClient } from '../client';
import { GableHttpError, describeRefusal, refusalCodeOf } from '../errors';

/**
 * The wire, for the eight capabilities added on top of migration 084.
 *
 * These assert the REQUEST as much as the response, because that is the half
 * that cannot be caught by reading a screen: a `?since=` sent as `?created=`,
 * an `If-None-Match` omitted, a `project_id` dropped by `JSON.stringify`
 * because it was `undefined` — every one of those degrades silently into
 * "works, but does more work than it needs to" or "works, but files the order
 * against nothing".
 *
 * The 409 paths are asserted separately, because `gable` deliberately does two
 * things there that a generic error path would flatten: it sends a stable
 * machine `code`, and it sends a hand-written customer-safe `reason` that
 * survives the message scrubbing every other status gets.
 */

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
  return { impl: impl as unknown as typeof fetch, calls };
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function client(fetchImpl: typeof fetch) {
  return createGableClient({ baseUrl: '/api/portal/v1', fetchImpl });
}

function headerOf(init: RequestInit, name: string): string | undefined {
  const headers = init.headers as Record<string, string> | undefined;
  return headers?.[name];
}

const QUOTE = {
  id: '2f2a2d6e-3f3e-4a0f-9f5f-0d1b7a1c2e34',
  status: 'REQUESTED',
  erp_state: 'DRAFT',
  project_id: null,
  project_name: null,
  notes: 'Framing package',
  priced: false,
  total_amount: 0,
  freight_amount: 0,
  delivery_type: 'DELIVERY',
  expires_at: null,
  sent_at: null,
  accepted_at: null,
  rejected_at: null,
  created_at: '2026-08-24T17:00:00Z',
  updated_at: '2026-08-24T17:00:00Z',
  lines: [],
};

// --- 1. Quotes ----------------------------------------------------------

describe('quotes: a scope goes out, a price comes back', () => {
  it('sends a scope with NO price field anywhere in the body', async () => {
    const fetchStub = stubFetch(() => json(QUOTE, 201));

    await client(fetchStub.impl).createQuote({
      notes: 'Framing package',
      delivery_type: 'DELIVERY',
      lines: [
        { product_id: 'p-1', description: '2x4x8 SPF', quantity: 40, uom: 'EA', note: '' },
        // The case that could not leave this browser before: a special-order
        // line, described in words, with no catalog product behind it.
        { description: 'Custom 36" fir door', quantity: 1, uom: 'EA', note: 'Left hand swing' },
      ],
    });

    const body = JSON.parse(String(fetchStub.calls[0]?.init.body)) as Record<string, unknown>;
    const serialised = JSON.stringify(body);

    // The contract is that a contractor sends a scope and a dealer prices it.
    // Any of these appearing would make the endpoint a store for
    // contractor-owned money data.
    expect(serialised).not.toContain('unit_price');
    expect(serialised).not.toContain('price');
    expect(serialised).not.toContain('markup');

    const lines = body.lines as Record<string, unknown>[];
    expect(lines).toHaveLength(2);
    expect(lines[0]?.product_id).toBe('p-1');
    // Absent, not null-as-string: `gable` reads a missing product_id as the
    // special-order case and then REQUIRES description and uom.
    expect(lines[1]).not.toHaveProperty('product_id');
    expect(lines[1]?.description).toBe('Custom 36" fir door');
    expect(lines[1]?.uom).toBe('EA');
  });

  it('accepts and declines by id, with no body to be misread as a price', async () => {
    const fetchStub = stubFetch(() => json({ ...QUOTE, status: 'ACCEPTED', priced: true }));
    const api = client(fetchStub.impl);

    await api.acceptQuote(QUOTE.id);
    await api.declineQuote(QUOTE.id);

    expect(fetchStub.calls[0]?.url).toBe(`/api/portal/v1/quotes/${QUOTE.id}/accept`);
    expect(fetchStub.calls[0]?.init.method).toBe('POST');
    expect(fetchStub.calls[0]?.init.body).toBeUndefined();
    expect(fetchStub.calls[1]?.url).toBe(`/api/portal/v1/quotes/${QUOTE.id}/decline`);
  });

  it('surfaces QUOTE_NOT_PRICED as a code AND the dealer’s own sentence', async () => {
    // The real 409 envelope: `message` is the scrubbed generic, `reason` is
    // the hand-written one. A client that only read `message` would tell a
    // contractor "Conflict".
    const fetchStub = stubFetch(() =>
      json(
        {
          error: {
            code: 'QUOTE_NOT_PRICED',
            message: 'Conflict',
            reason:
              'This quote has not been priced and sent by the dealer yet, or it has already been closed.',
          },
          meta: { request_id: 'r-1' },
        },
        409,
      ),
    );

    const error = await client(fetchStub.impl)
      .acceptQuote(QUOTE.id)
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(GableHttpError);
    expect(refusalCodeOf(error)).toBe('QUOTE_NOT_PRICED');
    expect(describeRefusal(error)).toContain('has not been priced');
    // And nothing invented: the reason shown is the dealer's, verbatim.
    expect(describeRefusal(error)).not.toContain('Conflict');
  });

  it('parses an unpriced quote without treating its $0.00 as a quotation', async () => {
    const fetchStub = stubFetch(() => json(QUOTE, 201));
    const created = await client(fetchStub.impl).createQuote({
      notes: '',
      delivery_type: 'PICKUP',
      lines: [{ product_id: 'p-1', description: 'x', quantity: 1, uom: 'EA', note: '' }],
    });

    // `priced` is derived by `gable` from the lifecycle, not from the total.
    // Branching on `total_amount === 0` would call a real goodwill quote
    // unpriced and an unpriced request a $0.00 offer.
    expect(created.priced).toBe(false);
    expect(created.total_amount).toBe(0);
  });
});

// --- 2. project_id on orders --------------------------------------------

describe('project association', () => {
  it('carries project_id on checkout', async () => {
    const fetchStub = stubFetch(() => json({ order_id: 'o-1', message: 'ok' }, 201));

    await client(fetchStub.impl).checkout({
      delivery_method: 'DELIVERY',
      delivery_address: '',
      payment_method: 'ACCOUNT',
      notes: 'Framing',
      project_id: 'prj-1',
    });

    const body = JSON.parse(String(fetchStub.calls[0]?.init.body)) as Record<string, unknown>;
    expect(body.project_id).toBe('prj-1');
  });

  it('sends an explicit null to DETACH, rather than an empty body', async () => {
    const fetchStub = stubFetch(() =>
      json({ id: 'o-1', status: 'CONFIRMED', total_amount: 1, created_at: 'x', lines: [] }),
    );

    await client(fetchStub.impl).setOrderProject('o-1', null);

    expect(fetchStub.calls[0]?.init.method).toBe('PUT');
    // `{}` would also detach, but only because Go decodes a missing key as a
    // nil pointer. Sending the null makes the intent the instruction.
    expect(String(fetchStub.calls[0]?.init.body)).toBe('{"project_id":null}');
  });

  it('filters the order list by project on the SERVER, not here', async () => {
    const fetchStub = stubFetch(() => json([], 200));

    await client(fetchStub.impl).orderFeed({ projectId: 'prj-1' });

    // The tenancy check lives in `gable` — it 404s another customer's project.
    // Pulling everything and filtering in a browser would move that check into
    // the one place it means nothing.
    expect(fetchStub.calls[0]?.url).toContain('project_id=prj-1');
  });
});

// --- 3. Order cancellation ----------------------------------------------

describe('cancellation refusals keep their distinct codes', () => {
  const refusal = (code: string, reason: string) => () =>
    json({ error: { code, message: 'Conflict', reason }, meta: { request_id: 'r' } }, 409);

  it('reports ORDER_ALREADY_CANCELLED', async () => {
    const fetchStub = stubFetch(
      refusal('ORDER_ALREADY_CANCELLED', 'This order has already been cancelled.'),
    );
    const error = await client(fetchStub.impl)
      .cancelOrder('o-1', 'changed my mind')
      .catch((caught: unknown) => caught);

    expect(refusalCodeOf(error)).toBe('ORDER_ALREADY_CANCELLED');
    expect(describeRefusal(error)).toContain('already been cancelled');
  });

  it('reports ORDER_NOT_CANCELLABLE for a fulfilled order, which is a different problem', async () => {
    const fetchStub = stubFetch(
      refusal(
        'ORDER_NOT_CANCELLABLE',
        'A fulfilled order cannot be cancelled. Ask the dealer for a credit.',
      ),
    );
    const error = await client(fetchStub.impl)
      .cancelOrder('o-1', '')
      .catch((caught: unknown) => caught);

    expect(refusalCodeOf(error)).toBe('ORDER_NOT_CANCELLABLE');
    // "Ask for a credit" is a different instruction from "it is already
    // cancelled", and a consumer that collapsed them would give the wrong one.
    expect(describeRefusal(error)).toContain('credit');
  });

  it('reports ORDER_IN_MOTION for goods on a dispatched route', async () => {
    const fetchStub = stubFetch(
      refusal(
        'ORDER_IN_MOTION',
        "This order's goods are already on a dispatched route or delivered. Call the dealer.",
      ),
    );
    const error = await client(fetchStub.impl)
      .cancelOrder('o-1', '')
      .catch((caught: unknown) => caught);

    expect(refusalCodeOf(error)).toBe('ORDER_IN_MOTION');
    expect(describeRefusal(error)).toContain('dispatched route');
  });

  it('does not treat a 404 as a refusal — there is no code to act on', async () => {
    const fetchStub = stubFetch(() => json({ error: { message: 'Not Found' } }, 404));
    const error = await client(fetchStub.impl)
      .cancelOrder('o-1', '')
      .catch((caught: unknown) => caught);

    // 404 is "there is no such thing here"; 409 is "there is, and the answer
    // is no". Only the second one carries a reason worth repeating.
    expect(refusalCodeOf(error)).toBeUndefined();
  });
});

// --- 4. Delivery reschedule ---------------------------------------------

describe('reschedule is a request queue', () => {
  const PENDING = {
    id: 'rr-1',
    delivery_id: 'd-1',
    order_id: 'o-1',
    requested_date: '2026-09-04',
    reason: 'Requested from the contractor portal',
    status: 'PENDING',
    applied: false,
    current_scheduled_date: '2026-08-28',
    resolution_note: null,
    created_at: '2026-08-24T17:00:00Z',
    updated_at: '2026-08-24T17:00:00Z',
  };

  it('sends a calendar DAY, not a timestamp', async () => {
    const fetchStub = stubFetch(() => json(PENDING, 202));

    await client(fetchStub.impl).requestReschedule('d-1', {
      requested_date: '2026-09-04',
      reason: 'crew moved',
    });

    const body = JSON.parse(String(fetchStub.calls[0]?.init.body)) as Record<string, unknown>;
    // A delivery is scheduled to a day. Sending an instant would imply the
    // dealer can commit to an hour, which no part of this system can honour.
    expect(body.requested_date).toBe('2026-09-04');
    expect(String(body.requested_date)).not.toContain('T');
  });

  it('reads back applied:false alongside the date the dealer’s board still says', async () => {
    const fetchStub = stubFetch(() => json(PENDING, 202));
    const dto = await client(fetchStub.impl).requestReschedule('d-1', {
      requested_date: '2026-09-04',
      reason: '',
    });

    expect(dto.applied).toBe(false);
    expect(dto.status).toBe('PENDING');
    // Both dates present, so a consumer can show the ask next to the answer.
    expect(dto.current_scheduled_date).toBe('2026-08-28');
  });

  it('answers null, not an error, when no request was ever filed (204)', async () => {
    const fetchStub = stubFetch(() => new Response(null, { status: 204 }));

    // 204 means "your delivery, no request". Throwing here would make a normal
    // state look like a failure and hide the button that files one.
    await expect(client(fetchStub.impl).reschedule('d-1')).resolves.toBeNull();
  });

  it('surfaces DELIVERY_COMMITTED when the load is already on a truck', async () => {
    const fetchStub = stubFetch(() =>
      json(
        {
          error: {
            code: 'DELIVERY_COMMITTED',
            message: 'Conflict',
            reason:
              'This delivery can no longer be rescheduled from the portal — the load is already on a truck or the stop is complete. Call the dealer.',
          },
          meta: { request_id: 'r' },
        },
        409,
      ),
    );

    const error = await client(fetchStub.impl)
      .requestReschedule('d-1', { requested_date: '2026-09-04', reason: '' })
      .catch((caught: unknown) => caught);

    expect(refusalCodeOf(error)).toBe('DELIVERY_COMMITTED');
    expect(describeRefusal(error)).toContain('already on a truck');
  });
});

// --- 6 & 7. Volume breaks and the category tree -------------------------

describe('catalog: ladders and aisles', () => {
  it('reads a per-customer ladder from its own endpoint', async () => {
    const fetchStub = stubFetch(() =>
      json([
        {
          min_quantity: 100,
          unit_price: 4.5,
          price_source: 'VOLUME',
          details: '100+ EA',
          saves_per_unit: 0.45,
        },
      ]),
    );

    const breaks = await client(fetchStub.impl).volumeBreaks('p-1');

    expect(fetchStub.calls[0]?.url).toBe('/api/portal/v1/catalog/p-1/volume-breaks');
    expect(breaks[0]?.min_quantity).toBe(100);
    expect(breaks[0]?.saves_per_unit).toBeCloseTo(0.45);
  });

  it('parses a nested category tree, leaves included', async () => {
    const fetchStub = stubFetch(() =>
      json([
        {
          id: 'c-1',
          name: 'Lumber',
          slug: 'lumber',
          path: 'lumber',
          depth: 0,
          sort_order: 1,
          product_count: 12,
          children: [
            {
              id: 'c-2',
              name: 'Framing',
              slug: 'framing',
              path: 'lumber.framing',
              depth: 1,
              sort_order: 1,
              product_count: 7,
              children: [],
            },
          ],
        },
      ]),
    );

    const tree = await client(fetchStub.impl).categories();

    expect(fetchStub.calls[0]?.url).toBe('/api/portal/v1/catalog/categories');
    expect(tree[0]?.children[0]?.path).toBe('lumber.framing');
    // The parent's count is the SUBTREE count, which is what `?category_id=`
    // returns — so a chip reading "Lumber 12" and a list of 12 agree.
    expect(tree[0]?.product_count).toBe(12);
  });

  it('sends category_id as its own parameter, distinct from the flat category string', async () => {
    const fetchStub = stubFetch(() => json([]));

    await client(fetchStub.impl).catalog({ category_id: 'c-1', category: 'Lumber' });

    const url = fetchStub.calls[0]?.url ?? '';
    expect(url).toContain('category_id=c-1');
    expect(url).toContain('category=Lumber');
  });
});

// --- 8. The change feed --------------------------------------------------

describe('the change feed is conditional', () => {
  const ORDER = {
    id: 'o-1',
    status: 'CONFIRMED',
    total_amount: 341.88,
    created_at: '2026-08-24T17:00:00Z',
    updated_at: '2026-08-24T18:00:00Z',
    project_id: 'prj-1',
    project_name: 'Wilson House',
    lines: [],
  };

  it('sends If-None-Match and ?since=, and reports a 304 as orders:null', async () => {
    const fetchStub = stubFetch(
      () => new Response(null, { status: 304, headers: { ETag: '"v1"' } }),
    );

    const feed = await client(fetchStub.impl).orderFeed({
      since: '2026-08-24T18:00:00Z',
      ifNoneMatch: '"v1"',
    });

    expect(headerOf(fetchStub.calls[0]?.init ?? {}, 'If-None-Match')).toBe('"v1"');
    expect(fetchStub.calls[0]?.url).toContain('since=2026-08-24T18%3A00%3A00Z');
    // null, NOT []. An empty array means "nothing has changed since your
    // cursor"; null means the ERP did not even send a body. Collapsing them
    // would make a 304 indistinguishable from a wipe.
    expect(feed.orders).toBeNull();
    expect(feed.etag).toBe('"v1"');
  });

  it('returns the order and the next cursor when something moved', async () => {
    const fetchStub = stubFetch(() =>
      json([ORDER], 200, {
        ETag: '"v2"',
        'X-Portal-Latest-Change': '2026-08-24T18:00:00Z',
      }),
    );

    const feed = await client(fetchStub.impl).orderFeed({ ifNoneMatch: '"v1"' });

    expect(feed.orders).toHaveLength(1);
    expect(feed.orders?.[0]?.project_id).toBe('prj-1');
    expect(feed.etag).toBe('"v2"');
    expect(feed.latestChange).toBe('2026-08-24T18:00:00Z');
  });

  it('omits If-None-Match entirely on a first read rather than sending an empty one', async () => {
    const fetchStub = stubFetch(() => json([], 200));

    await client(fetchStub.impl).orderFeed({});

    // An `If-None-Match: ` header is a header the ERP has to parse for
    // nothing, and `undefined` would serialise as the literal "undefined" and
    // never match any validator.
    expect(headerOf(fetchStub.calls[0]?.init ?? {}, 'If-None-Match')).toBeUndefined();
    expect(fetchStub.calls[0]?.url).not.toContain('since=');
  });
});
