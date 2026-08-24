// SPDX-License-Identifier: LicenseRef-OpenLBM-Community-Source-1.0
// SPDX-FileCopyrightText: 2026 FutureBuild, Inc. and OpenLBM contributors
import type { z } from 'zod';
import { GableAuthError, GableHttpError, GableNetworkError, GableShapeError } from './errors';
import {
  type GableCart,
  type GableCatalogDetail,
  type GableCatalogFilter,
  type GableCatalogProduct,
  type GableCheckoutRequest,
  type GableCheckoutResponse,
  type GableConfig,
  type GableDashboard,
  type GableDelivery,
  type GableLoginResponse,
  type GableOrder,
  type GableProject,
  gableCartSchema,
  gableCatalogDetailSchema,
  gableCatalogListSchema,
  gableCheckoutResponseSchema,
  gableConfigSchema,
  gableDashboardSchema,
  gableDeliveryListSchema,
  gableErrorSchema,
  gableLoginResponseSchema,
  gableOrderListSchema,
  gableOrderSchema,
  gableProjectListSchema,
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
  signal?: AbortSignal | undefined;
}

const DEFAULT_TIMEOUT_MS = 15_000;

export interface GableClient {
  login(email: string, password: string): Promise<GableLoginResponse>;
  logout(): Promise<void>;
  config(): Promise<GableConfig>;
  dashboard(signal?: AbortSignal): Promise<GableDashboard>;

  catalog(filter?: GableCatalogFilter, signal?: AbortSignal): Promise<GableCatalogProduct[]>;
  catalogProduct(id: string, signal?: AbortSignal): Promise<GableCatalogDetail>;

  cart(signal?: AbortSignal): Promise<GableCart>;
  addCartItem(productId: string, quantity: number): Promise<GableCart>;
  updateCartItem(itemId: string, quantity: number): Promise<GableCart>;
  removeCartItem(itemId: string): Promise<GableCart>;
  checkout(request: GableCheckoutRequest): Promise<GableCheckoutResponse>;

  orders(signal?: AbortSignal): Promise<GableOrder[]>;
  order(id: string, signal?: AbortSignal): Promise<GableOrder>;
  deliveries(signal?: AbortSignal): Promise<GableDelivery[]>;
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

/** The ERP's own sentence, if it sent one. Never fabricated. */
function detailFrom(raw: string): string | undefined {
  try {
    const parsed = gableErrorSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data.error.message : undefined;
  } catch {
    return undefined;
  }
}

export function createGableClient(options: GableClientOptions): GableClient {
  const doFetch = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  async function request<T>(request: RequestOptions<T>): Promise<T> {
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
      throw new GableHttpError(
        response.status,
        `The supplier refused ${request.method} ${request.path} (HTTP ${response.status}).`,
        detailFrom(raw),
      );
    }

    if (!request.schema) return undefined as T;

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
    return result.data;
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

    order: (id, signal) =>
      request({
        method: 'GET',
        path: `/orders/${encodeURIComponent(id)}`,
        schema: gableOrderSchema,
        signal,
      }),

    deliveries: (signal) =>
      request({ method: 'GET', path: '/deliveries', schema: gableDeliveryListSchema, signal }),

    projects: (signal) =>
      request({ method: 'GET', path: '/projects', schema: gableProjectListSchema, signal }),
  };
}
