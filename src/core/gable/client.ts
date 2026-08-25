// SPDX-License-Identifier: LicenseRef-OpenLBM-Community-Source-1.0
// SPDX-FileCopyrightText: 2026 FutureBuild, Inc. and OpenLBM contributors
import type { z } from 'zod';
import { GableAuthError, GableHttpError, GableNetworkError, GableShapeError } from './errors';
import {
  type GableCancelResponse,
  type GableCart,
  type GableCatalogDetail,
  type GableCatalogFilter,
  type GableCatalogProduct,
  type GableCategoryNode,
  type GableCheckoutRequest,
  type GableCheckoutResponse,
  type GableConfig,
  type GableCreateQuoteRequest,
  type GableDashboard,
  type GableDelivery,
  type GableLoginResponse,
  type GableOrder,
  type GableOrderFeed,
  type GableProject,
  type GableQuote,
  type GableReschedule,
  type GableRescheduleRequest,
  type GableVolumeBreak,
  gableCancelResponseSchema,
  gableCartSchema,
  gableCatalogDetailSchema,
  gableCatalogListSchema,
  gableCategoryTreeSchema,
  gableCheckoutResponseSchema,
  gableConfigSchema,
  gableDashboardSchema,
  gableDeliveryListSchema,
  gableErrorSchema,
  gableLoginResponseSchema,
  gableOrderListSchema,
  gableOrderSchema,
  gableProjectListSchema,
  gableQuoteListSchema,
  gableQuoteSchema,
  gableRescheduleSchema,
  gableVolumeBreakListSchema,
} from './schema';

/**
 * The HTTP client for `gable`'s portal API.
 *
 * Three things about it are load-bearing and none are obvious:
 *
 * 1. **There is no token to hold.** `gable` returns the JWT as an httpOnly
 *    `portal_token` cookie and never in the body. This client therefore has no
 *    `Authorization` header path and no storage — it sets `credentials` and
 *    lets the browser do it. That also means an XSS in the portal cannot
 *    exfiltrate the session, which is the whole reason `gable` does it that
 *    way.
 *
 * 2. **A 401 is terminal.** It throws `GableAuthError` and does not retry, does
 *    not re-issue, and does not attempt a silent re-login. `gable`'s own
 *    browser client originally ran its 401 interceptor inside the retry loop,
 *    which double-posted non-idempotent calls; the comment recording that fix
 *    is still in `gable/app/src/services/fetchClient.ts`. Not repeating it here
 *    is a deliberate decision, not an omission.
 *
 * 3. **Every 2xx body is parsed.** An unrecognised shape is a `GableShapeError`
 *    rather than a best-effort read, because the alternative is a float dollar
 *    silently becoming `undefined` and then `NaN` on a contractor's total.
 *
 * The client is framework-free and takes its `fetch` by injection, so the tests
 * drive it with a stub rather than a live ERP.
 */

export interface GableClientOptions {
  /**
   * Where the portal API lives. Normally the SAME-ORIGIN proxy path
   * `/api/portal/v1` — see `server/gable-proxy.ts` for why it cannot be the
   * ERP's own origin: the session cookie is `SameSite=Strict` and scoped to
   * `Path=/api/portal`, so a cross-site request never carries it.
   */
  baseUrl: string;
  /** Injected for tests; defaults to the global. */
  fetchImpl?: typeof fetch;
  /**
   * Called once per 401, before the error is thrown. This is how session
   * expiry mid-session reaches the UI without every call site handling it.
   */
  onUnauthorized?: () => void;
  /** Per-request timeout. A hung ERP must not hang the board forever. */
  timeoutMs?: number;
}

interface RequestOptions<T> {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  path: string;
  schema?: z.ZodType<T>;
  body?: unknown;
  query?: Record<string, string | undefined>;
  headers?: Record<string, string | undefined>;
  signal?: AbortSignal | undefined;
  /**
   * Non-2xx statuses that are an ANSWER rather than a failure — 304 on the
   * conditional order feed, 204 on a reschedule that was never filed. Listing
   * them per-call rather than globally keeps a stray 304 from a route that
   * should never send one an error, which is what it would be.
   */
  expect?: number[];
}

/** A response whose status and headers the caller needs, not just its body. */
interface RawResponse<T> {
  status: number;
  header: (name: string) => string | undefined;
  /** Undefined when the status was in `expect` and carried no body. */
  data: T | undefined;
}

const DEFAULT_TIMEOUT_MS = 15_000;

/**
 * `?since=` on the order feed. Optional cursor and optional project scope,
 * plus the validator to send as `If-None-Match`.
 */
export interface GableOrderFeedQuery {
  since?: string | undefined;
  projectId?: string | undefined;
  ifNoneMatch?: string | undefined;
}

export interface GableClient {
  login(email: string, password: string): Promise<GableLoginResponse>;
  logout(): Promise<void>;
  config(): Promise<GableConfig>;
  dashboard(signal?: AbortSignal): Promise<GableDashboard>;

  catalog(filter?: GableCatalogFilter, signal?: AbortSignal): Promise<GableCatalogProduct[]>;
  catalogProduct(id: string, signal?: AbortSignal): Promise<GableCatalogDetail>;
  categories(signal?: AbortSignal): Promise<GableCategoryNode[]>;
  volumeBreaks(productId: string, signal?: AbortSignal): Promise<GableVolumeBreak[]>;

  cart(signal?: AbortSignal): Promise<GableCart>;
  addCartItem(productId: string, quantity: number): Promise<GableCart>;
  updateCartItem(itemId: string, quantity: number): Promise<GableCart>;
  removeCartItem(itemId: string): Promise<GableCart>;
  checkout(request: GableCheckoutRequest): Promise<GableCheckoutResponse>;

  orders(signal?: AbortSignal): Promise<GableOrder[]>;
  /** Conditional read. Answers `{ orders: null }` on a 304 — see `GableOrderFeed`. */
  orderFeed(query: GableOrderFeedQuery, signal?: AbortSignal): Promise<GableOrderFeed>;
  order(id: string, signal?: AbortSignal): Promise<GableOrder>;
  cancelOrder(id: string, reason: string): Promise<GableCancelResponse>;
  /** `null` detaches the order from its project. */
  setOrderProject(id: string, projectId: string | null): Promise<GableOrder>;

  deliveries(signal?: AbortSignal): Promise<GableDelivery[]>;
  requestReschedule(deliveryId: string, request: GableRescheduleRequest): Promise<GableReschedule>;
  /** `null` when this customer has never filed one for that delivery (204). */
  reschedule(deliveryId: string, signal?: AbortSignal): Promise<GableReschedule | null>;

  quotes(signal?: AbortSignal): Promise<GableQuote[]>;
  quote(id: string, signal?: AbortSignal): Promise<GableQuote>;
  createQuote(request: GableCreateQuoteRequest): Promise<GableQuote>;
  acceptQuote(id: string): Promise<GableQuote>;
  declineQuote(id: string): Promise<GableQuote>;

  projects(signal?: AbortSignal): Promise<GableProject[]>;
}

/**
 * Join without producing `//` or losing a path segment. `new URL()` is not an
 * option: `baseUrl` is normally a relative path (`/api/portal/v1`) and `URL`
 * refuses those without a base, which differs between jsdom and a real browser.
 */
function joinUrl(baseUrl: string, path: string): string {
  const base = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
  const tail = path.startsWith('/') ? path : `/${path}`;
  return `${base}${tail}`;
}

function withQuery(url: string, query: Record<string, string | undefined> | undefined): string {
  if (!query) return url;
  const parts: string[] = [];
  for (const [key, value] of Object.entries(query)) {
    // An empty filter must not be sent: `gable` treats `?q=` as a real (empty)
    // filter term in its SQL, and the difference is a full catalog vs none.
    if (value === undefined || value === '') continue;
    parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(value)}`);
  }
  return parts.length > 0 ? `${url}?${parts.join('&')}` : url;
}

/**
 * The ERP's own words, if it sent any. Never fabricated.
 *
 * `reason` only appears on a 409 refusal and is the one message `gable`
 * deliberately does NOT scrub — it is hand-written, contains no ids and no
 * table names, and is the only thing a consumer can put in front of a
 * contractor when the dealer says no.
 */
function errorBodyFrom(raw: string): {
  message: string | undefined;
  code: string | undefined;
  reason: string | undefined;
} {
  try {
    const parsed = gableErrorSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) return { message: undefined, code: undefined, reason: undefined };
    return {
      message: parsed.data.error.message,
      code: parsed.data.error.code,
      reason: parsed.data.error.reason,
    };
  } catch {
    return { message: undefined, code: undefined, reason: undefined };
  }
}

export function createGableClient(options: GableClientOptions): GableClient {
  const doFetch = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  async function requestRaw<T>(request: RequestOptions<T>): Promise<RawResponse<T>> {
    const url = withQuery(joinUrl(options.baseUrl, request.path), request.query);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    // A caller-supplied signal (a page unmounting) has to win too, so both are
    // honoured rather than one replacing the other.
    const onAbort = () => controller.abort();
    request.signal?.addEventListener('abort', onAbort);

    let response: Response;
    try {
      response = await doFetch(url, {
        method: request.method,
        // The session is an httpOnly cookie. Without this the browser sends
        // nothing and every protected call is a 401 — the failure mode reads
        // like "wrong password" and is actually "wrong fetch option".
        credentials: 'include',
        headers: {
          Accept: 'application/json',
          ...(request.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
          // An undefined value would serialise as the string "undefined" and
          // an empty `If-None-Match` is a header the ERP has to parse for
          // nothing, so both are dropped rather than sent.
          ...Object.fromEntries(
            Object.entries(request.headers ?? {}).filter(
              (entry): entry is [string, string] => typeof entry[1] === 'string' && entry[1] !== '',
            ),
          ),
        },
        ...(request.body !== undefined ? { body: JSON.stringify(request.body) } : {}),
        signal: controller.signal,
      });
    } catch (error) {
      throw new GableNetworkError(
        controller.signal.aborted
          ? `The supplier did not answer ${request.method} ${request.path} in time.`
          : `Could not reach the supplier (${request.method} ${request.path}).`,
        error,
      );
    } finally {
      clearTimeout(timer);
      request.signal?.removeEventListener('abort', onAbort);
    }

    // Read once: a Response body is a one-shot stream, and reading it twice to
    // "try JSON then fall back to text" throws on the second read.
    const raw = await response.text().catch(() => '');
    const header = (name: string): string | undefined => response.headers?.get(name) ?? undefined;

    // A status the caller asked about explicitly — 304 "nothing moved", 204
    // "there is no such record yet". Both are answers, and neither has a body
    // worth parsing.
    if (request.expect?.includes(response.status)) {
      return { status: response.status, header, data: undefined };
    }

    if (response.status === 401) {
      // Terminal. No retry, no re-issue, no silent re-login. See the class
      // comment on GableAuthError.
      //
      // A 401 from `/login` is NOT a session expiry — it is a rejected
      // credential, and the two need opposite words and opposite handling. The
      // live transcript caught this: a wrong password told the contractor
      // "your session has expired", and fired the expiry handler, which tore
      // down a session that had never existed. `/login` is the one path where
      // 401 is the expected answer to a normal question.
      if (request.path === '/login') {
        throw new GableAuthError('That email and password did not match. Try again.');
      }
      options.onUnauthorized?.();
      throw new GableAuthError();
    }

    if (!response.ok) {
      const body = errorBodyFrom(raw);
      throw new GableHttpError(
        response.status,
        `The supplier refused ${request.method} ${request.path} (HTTP ${response.status}).`,
        body.message,
        { code: body.code, reason: body.reason },
      );
    }

    if (!request.schema) return { status: response.status, header, data: undefined };

    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(raw);
    } catch {
      throw new GableShapeError(request.path, ['the body was not JSON']);
    }

    const result = request.schema.safeParse(parsedJson);
    if (!result.success) {
      throw new GableShapeError(
        request.path,
        result.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`),
      );
    }
    return { status: response.status, header, data: result.data };
  }

  /** The common case: a 2xx whose body is the answer. */
  async function request<T>(options: RequestOptions<T>): Promise<T> {
    const { data } = await requestRaw(options);
    return data as T;
  }

  return {
    login: (email, password) =>
      request({
        method: 'POST',
        path: '/login',
        body: { email, password },
        schema: gableLoginResponseSchema,
      }),

    // `gable` answers 200 with an empty body and an expiring cookie. No schema.
    logout: () => request<void>({ method: 'POST', path: '/logout' }),

    config: () => request({ method: 'GET', path: '/config', schema: gableConfigSchema }),

    dashboard: (signal) =>
      request({ method: 'GET', path: '/dashboard', schema: gableDashboardSchema, signal }),

    catalog: (filter, signal) =>
      request({
        method: 'GET',
        path: '/catalog',
        schema: gableCatalogListSchema,
        query: {
          q: filter?.q,
          category: filter?.category,
          category_id: filter?.category_id,
          species: filter?.species,
          grade: filter?.grade,
        },
        signal,
      }),

    catalogProduct: (id, signal) =>
      request({
        method: 'GET',
        path: `/catalog/${encodeURIComponent(id)}`,
        schema: gableCatalogDetailSchema,
        signal,
      }),

    // Registered on `gable` before the `{id}` pattern; Go 1.22's mux resolves
    // by specificity, so `categories` is never read as a product id.
    categories: (signal) =>
      request({
        method: 'GET',
        path: '/catalog/categories',
        schema: gableCategoryTreeSchema,
        signal,
      }),

    volumeBreaks: (productId, signal) =>
      request({
        method: 'GET',
        path: `/catalog/${encodeURIComponent(productId)}/volume-breaks`,
        schema: gableVolumeBreakListSchema,
        signal,
      }),

    cart: (signal) => request({ method: 'GET', path: '/cart', schema: gableCartSchema, signal }),

    addCartItem: (productId, quantity) =>
      request({
        method: 'POST',
        path: '/cart/items',
        body: { product_id: productId, quantity },
        schema: gableCartSchema,
      }),

    updateCartItem: (itemId, quantity) =>
      request({
        method: 'PUT',
        path: `/cart/items/${encodeURIComponent(itemId)}`,
        body: { quantity },
        schema: gableCartSchema,
      }),

    removeCartItem: (itemId) =>
      request({
        method: 'DELETE',
        path: `/cart/items/${encodeURIComponent(itemId)}`,
        schema: gableCartSchema,
      }),

    checkout: (checkoutRequest) =>
      request({
        method: 'POST',
        path: '/checkout',
        body: checkoutRequest,
        schema: gableCheckoutResponseSchema,
      }),

    orders: (signal) =>
      request({ method: 'GET', path: '/orders', schema: gableOrderListSchema, signal }),

    orderFeed: async (query, signal) => {
      const raw = await requestRaw({
        method: 'GET',
        path: '/orders',
        schema: gableOrderListSchema,
        query: { since: query.since, project_id: query.projectId },
        headers: { 'If-None-Match': query.ifNoneMatch },
        // 304 is the point of the call, not a failure.
        expect: [304],
        signal,
      });

      return {
        orders: raw.status === 304 ? null : (raw.data ?? []),
        etag: raw.header('ETag'),
        latestChange: raw.header('X-Portal-Latest-Change'),
      };
    },

    order: (id, signal) =>
      request({
        method: 'GET',
        path: `/orders/${encodeURIComponent(id)}`,
        schema: gableOrderSchema,
        signal,
      }),

    cancelOrder: (id, reason) =>
      request({
        method: 'POST',
        path: `/orders/${encodeURIComponent(id)}/cancel`,
        body: { reason },
        schema: gableCancelResponseSchema,
      }),

    setOrderProject: (id, projectId) =>
      request({
        method: 'PUT',
        path: `/orders/${encodeURIComponent(id)}/project`,
        // Explicit null, not an omitted key: null is what detaches the order,
        // and `JSON.stringify` would drop an `undefined` and send `{}`, which
        // `gable` decodes as a nil pointer and treats as a detach anyway —
        // by accident rather than by instruction.
        body: { project_id: projectId },
        schema: gableOrderSchema,
      }),

    deliveries: (signal) =>
      request({ method: 'GET', path: '/deliveries', schema: gableDeliveryListSchema, signal }),

    // 202 Accepted. The ask is recorded; the schedule is NOT changed. The
    // returned DTO says so in `applied`.
    requestReschedule: (deliveryId, rescheduleRequest) =>
      request({
        method: 'POST',
        path: `/deliveries/${encodeURIComponent(deliveryId)}/reschedule`,
        body: rescheduleRequest,
        schema: gableRescheduleSchema,
      }),

    reschedule: async (deliveryId, signal) => {
      const raw = await requestRaw({
        method: 'GET',
        path: `/deliveries/${encodeURIComponent(deliveryId)}/reschedule`,
        schema: gableRescheduleSchema,
        // 204: the delivery is the caller's and no request was ever filed.
        // That is not a 404 and must not read as one.
        expect: [204],
        signal,
      });
      return raw.data ?? null;
    },

    quotes: (signal) =>
      request({ method: 'GET', path: '/quotes', schema: gableQuoteListSchema, signal }),

    quote: (id, signal) =>
      request({
        method: 'GET',
        path: `/quotes/${encodeURIComponent(id)}`,
        schema: gableQuoteSchema,
        signal,
      }),

    createQuote: (quoteRequest) =>
      request({ method: 'POST', path: '/quotes', body: quoteRequest, schema: gableQuoteSchema }),

    acceptQuote: (id) =>
      request({
        method: 'POST',
        path: `/quotes/${encodeURIComponent(id)}/accept`,
        schema: gableQuoteSchema,
      }),

    declineQuote: (id) =>
      request({
        method: 'POST',
        path: `/quotes/${encodeURIComponent(id)}/decline`,
        schema: gableQuoteSchema,
      }),

    projects: (signal) =>
      request({ method: 'GET', path: '/projects', schema: gableProjectListSchema, signal }),
  };
}
