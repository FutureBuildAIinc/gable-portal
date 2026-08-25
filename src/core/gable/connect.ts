// SPDX-License-Identifier: LicenseRef-OpenLBM-Community-Source-1.0
// SPDX-FileCopyrightText: 2026 FutureBuild, Inc. and OpenLBM contributors
import { getContext, installSupplier } from '../boot';
import type { Project } from '../domain/project';
import { type Result, err, ok } from '../lib/result';
import {
  catalogStore,
  customerQuotesStore,
  invoicesStore,
  ordersStore,
  projectsStore,
  quotesStore,
  salesOrdersStore,
  scopeStore,
  sessionStore,
} from '../stores/root';
import { collectionFrom, emptyCollection, listOf, upsert } from '../stores/store';
import { type GableClient, createGableClient } from './client';
import { GableAuthError, describeGableError } from './errors';
import { adoptOrderHistory, boardCardFrom } from './history';
import { catalogStateFrom } from './mapper';
import { type GablePricingEngine, createGablePricingEngine } from './pricing';
import { gableRuntime, isGableWired } from './runtime';
import type { GableCategoryNode, GableProject } from './schema';
import { gableStore, setGableState } from './store';
import { createGableSupplier, syncOrderStatus, syncQuotes } from './supplier';

/**
 * Connecting the portal to a live `gable`, and everything that has to be true
 * afterwards.
 *
 * This is the only module that both talks to the ERP and touches the app's
 * stores, and it is deliberately the last thing to run rather than part of
 * `boot()`. `boot()` is synchronous and always seeds the simulator; connecting
 * is asynchronous, can fail, and can be refused by a login screen. Folding it
 * into boot would make first paint wait on a network call and would mean a
 * dead ERP white-screens the app instead of degrading to "sign in again".
 *
 * The sequence, and why each step is in this order:
 *
 *   1. Sign in (or discover an existing cookie session).
 *   2. Pull the catalog and install the ERP pricing engine — BEFORE the board
 *      is shown, so no line is ever priced by the simulator's tier table while
 *      claiming to be live.
 *   3. Drop the seeded demo scenario and adopt the customer's real projects.
 *   4. Swap the supplier port and STOP the simulator's scheduler. A real ERP
 *      drives state; a timer must not be advancing orders behind it.
 */

const CACHED_USER_KEY = 'gn:gableUser';

let client: GableClient | null = null;
let syncTimer: ReturnType<typeof setInterval> | undefined;

/** Default poll interval. The ERP has no push channel on the portal surface. */
export const GABLE_SYNC_INTERVAL_MS = 30_000;

export function gableClient(): GableClient {
  if (!client) {
    client = createGableClient({
      baseUrl: gableRuntime().basePath,
      // One place turns a mid-session expiry into a sign-in prompt, instead of
      // every call site remembering to.
      onUnauthorized: () => {
        stopGableSync();
        setGableState({
          status: 'signed-out',
          user: null,
          error: 'Your session with the supplier expired. Sign in again.',
        });
        forgetCachedUser();
      },
    });
  }
  return client;
}

/** Tests drive the whole flow against a stub client. */
export function setGableClientForTesting(next: GableClient | null): void {
  client = next;
}

/**
 * The signed-in user's NAME and EMAIL, cached for display across a reload.
 *
 * This is not a credential and cannot be used as one — the session is an
 * httpOnly cookie the page cannot read, and the ERP re-checks it on every
 * request. The cache exists so a reload can render "Sam Kelbrook" immediately
 * instead of a blank header, and it is thrown away the moment the ERP says the
 * session is gone. Anything the cache claims is subordinate to what the server
 * last answered.
 */
function rememberUser(user: { name: string; email: string; customer_id: string }): void {
  try {
    globalThis.localStorage?.setItem(CACHED_USER_KEY, JSON.stringify(user));
  } catch {
    // Private mode, quota, or no localStorage at all. Display-only data.
  }
}

function forgetCachedUser(): void {
  try {
    globalThis.localStorage?.removeItem(CACHED_USER_KEY);
  } catch {
    // Nothing to do — the authoritative session is the cookie either way.
  }
}

function cachedUser(): { name: string; email: string; customer_id: string } | null {
  try {
    const raw = globalThis.localStorage?.getItem(CACHED_USER_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    const record = parsed as Record<string, unknown>;
    if (typeof record.name !== 'string' || typeof record.email !== 'string') return null;
    return {
      name: record.name,
      email: record.email,
      customer_id: typeof record.customer_id === 'string' ? record.customer_id : '',
    };
  } catch {
    return null;
  }
}

function projectFrom(dto: GableProject, now: string): Project {
  return {
    id: dto.id,
    accountId: dto.customer_id,
    name: dto.name,
    createdAt: dto.created_at || now,
    updatedAt: dto.updated_at || now,
    // `gable`'s project record carries a name, a status and two timestamps and
    // nothing else — no client name, no site address. Absent, not invented.
    ...(dto.status.trim().toUpperCase() === 'COMPLETED' ? { archivedAt: dto.updated_at } : {}),
  };
}

/**
 * Everything after a successful sign-in. Extracted so the login path and the
 * "cookie was still good" path cannot diverge.
 */
async function adopt(dealerName: string): Promise<void> {
  const api = gableClient();
  const context = getContext();
  const now = context.clock.nowIso();

  /**
   * The catalog and the category tree land together, because the tree is what
   * gives a product an aisle. Loading products first and the tree afterwards
   * would leave one render where every product sits in a synthesised
   * flat category and the browse chips reshuffle underneath the contractor.
   *
   * A tree failure is survivable and does NOT fail the connect: browse falls
   * back to the flat `category` display string exactly as it did before this
   * endpoint existed. A catalog failure is not survivable and propagates.
   */
  const [dtos, tree] = await Promise.all([
    api.catalog(),
    api.categories().catch((): GableCategoryNode[] => []),
  ]);

  const pricing: GablePricingEngine = createGablePricingEngine(dtos, {
    // The ladder for a product, fetched when something actually wants to show
    // one. Injected rather than imported so the engine has no opinion about
    // where prices come from — and so a standalone build never carries a path
    // that could reach the network.
    loadVolumeBreaks: (productId) => api.volumeBreaks(productId),
  });
  const catalog = catalogStateFrom(dtos, dealerName, tree);

  const projects = await api.projects();
  const adoptedProjects = projects.map((dto) => projectFrom(dto, now));

  /**
   * The seeded demo scenario is dropped, not merged.
   *
   * A board holding both simulated orders and real ones is unreadable and
   * dangerous — two cards side by side, one of which a dealer can see and one
   * of which exists only in this browser. Projects come from the ERP, and so
   * now does the order history: `PortalOrderDTO` carries `project_id`, so an
   * order the contractor placed at the counter lands on the job the DEALER
   * filed it against rather than being dropped for want of a home. See
   * `gable/history.ts`.
   */
  ordersStore.set(emptyCollection());
  scopeStore.set(emptyCollection());
  quotesStore.set(emptyCollection());
  salesOrdersStore.set(emptyCollection());
  invoicesStore.set(emptyCollection());
  customerQuotesStore.set(emptyCollection());
  projectsStore.set(collectionFrom(adoptedProjects));

  const supplier = createGableSupplier({
    client: api,
    nowIso: () => getContext().clock.nowIso(),
    dealerName,
  });

  // Catalog and pricing land together. Installing the products first would
  // leave one render where ERP products are priced by the simulator's tiers.
  installSupplier({ supplier, pricing, catalog });

  const history = await adoptOrderHistory({
    client: api,
    projects: adoptedProjects,
    products: catalog.products,
    dealerName,
    now,
  });
  ordersStore.set(collectionFrom(history.orders));
  scopeStore.set(collectionFrom(history.items));
  salesOrdersStore.set(collectionFrom(history.salesOrders));
  setGableState({
    unassignedOrders: history.unassigned,
    // The board was just rebuilt from a full read, so any cursor from a
    // previous session describes a world that no longer exists here. Cleared,
    // so the first poll is unconditional and cannot 304 past a change that
    // happened while nobody was connected.
    feedCursor: null,
    feedEtag: null,
    lastPollNotModified: false,
  });

  /**
   * The simulator's scheduler is STOPPED, not paused and not left ticking on a
   * different queue. On the wired path the ERP is the only thing that may move
   * an order, and a timer aging a card behind a live board is the precise bug
   * "retire the scheduler on the wired path" was written to prevent.
   */
  context.sim.scheduler.stop();
}

/**
 * Called once at startup. Decides which world the app is in, and — when wired —
 * finds out whether the browser already holds a valid session.
 */
export async function initGableConnection(): Promise<void> {
  if (!isGableWired()) {
    setGableState({ status: 'standalone', error: null });
    return;
  }

  setGableState({ status: 'connecting', error: null });

  const api = gableClient();
  let dealerName = 'your supplier';
  try {
    const config = await api.config();
    dealerName = config.dealer_name || dealerName;
    setGableState({ dealer: config });
  } catch (error) {
    // `/config` is public, so failing it means the ERP is unreachable rather
    // than that the session is bad. Say the true thing.
    setGableState({ status: 'error', error: describeGableError(error) });
    return;
  }

  try {
    // The cheapest authenticated call. A 200 means the cookie is still good;
    // a 401 means sign in. Nothing else distinguishes the two from here.
    await api.dashboard();
  } catch (error) {
    if (error instanceof GableAuthError) {
      forgetCachedUser();
      setGableState({ status: 'signed-out', user: null, error: null });
      return;
    }
    setGableState({ status: 'error', error: describeGableError(error) });
    return;
  }

  try {
    await adopt(dealerName);
  } catch (error) {
    setGableState({ status: 'error', error: describeGableError(error) });
    return;
  }

  const remembered = cachedUser();
  setGableState({
    status: 'connected',
    error: null,
    ...(remembered
      ? {
          user: {
            id: '',
            customer_id: remembered.customer_id,
            email: remembered.email,
            name: remembered.name,
            role: '',
            status: 'Active',
          },
        }
      : {}),
  });
  applySession(dealerName);
  startGableSync();
}

/** Sign in with real credentials against `POST /api/portal/v1/login`. */
export async function loginToGable(email: string, password: string): Promise<Result<void>> {
  if (!isGableWired()) {
    return err('This portal is running standalone — there is no supplier to sign in to.');
  }

  setGableState({ status: 'connecting', error: null });
  const api = gableClient();

  let dealerName = gableStore.get().dealer?.dealer_name ?? 'your supplier';
  try {
    const response = await api.login(email.trim(), password);
    dealerName = response.config.dealer_name || dealerName;
    rememberUser({
      name: response.user.name,
      email: response.user.email,
      customer_id: response.user.customer_id,
    });
    setGableState({ user: response.user, dealer: response.config });
  } catch (error) {
    const message =
      error instanceof GableAuthError
        ? 'That email and password did not match. Try again.'
        : describeGableError(error);
    setGableState({ status: 'signed-out', user: null, error: message });
    return err(message);
  }

  try {
    await adopt(dealerName);
  } catch (error) {
    setGableState({ status: 'error', error: describeGableError(error) });
    return err(describeGableError(error));
  }

  setGableState({ status: 'connected', error: null });
  applySession(dealerName);
  startGableSync();
  return ok(undefined);
}

/**
 * The header reads the account name out of `sessionStore`, which `boot()` filled
 * with the demo account. On the wired path it has to say who the ERP thinks you
 * are, or a contractor signed in as Kelbrook Construction reads "Summit
 * Builders" across the top of a live board.
 */
function applySession(dealerName: string): void {
  const state = gableStore.get();
  const existing = sessionStore.get();
  if (!existing.account) return;
  sessionStore.set({
    ...existing,
    account: {
      ...existing.account,
      id: state.user?.customer_id || existing.account.id,
      name: state.user?.name ? `${state.user.name} — ${dealerName}` : existing.account.name,
    },
  });
}

/**
 * File a dealer-side order that belongs to no job onto one of the
 * contractor's projects.
 *
 * This is `PUT /orders/{id}/project`, and it writes on the DEALER's side
 * first: the association belongs in the ERP, where the dealer's own reporting
 * and the next `?project_id=` read will see it. Only once `gable` has accepted
 * it does the card appear on the board — the reverse order would put a card on
 * a job and then discover the ERP had refused, which is the same class of lie
 * as a card in Order with no order behind it.
 */
export async function fileOrderOnProject(
  gableOrderId: string,
  projectId: string,
): Promise<Result<void>> {
  const state = gableStore.get();
  const dto = state.unassignedOrders.find((order) => order.id === gableOrderId);
  if (!dto) return err('That order is no longer waiting to be filed.');

  const project = projectsStore.get().byId[projectId];
  if (!project) return err('That project no longer exists.');

  const attached = await getContext().supplier.attachOrderToProject(gableOrderId, projectId);
  if (!attached.ok) return attached;

  const card = boardCardFrom({
    dto,
    projectId,
    products: catalogStore.get().products,
    dealerName: state.dealer?.dealer_name ?? 'your supplier',
    now: getContext().clock.nowIso(),
    sortOrder: listOf(ordersStore.get()).filter((order) => order.stage === 'order').length,
  });

  ordersStore.set(upsert(ordersStore.get(), card.order));
  let scope = scopeStore.get();
  for (const item of card.items) scope = upsert(scope, item);
  scopeStore.set(scope);
  salesOrdersStore.set(upsert(salesOrdersStore.get(), card.salesOrder));

  setGableState({
    unassignedOrders: state.unassignedOrders.filter((order) => order.id !== gableOrderId),
  });
  return ok(undefined);
}

export async function logoutFromGable(): Promise<void> {
  stopGableSync();
  try {
    await gableClient().logout();
  } catch {
    // A failed logout still ends the session here. The cookie expires on its
    // own; leaving the UI "signed in" because the network hiccuped is worse.
  }
  forgetCachedUser();
  setGableState({ status: 'signed-out', user: null, error: null });
}

/**
 * Read supplier state back from the ERP. Safe to call while one is in flight.
 *
 * The poll is CONDITIONAL: the ETag and cursor from the previous read go back
 * out as `If-None-Match` and `?since=`, so an interval that finds nothing
 * costs one 304 with no body instead of a full order list plus a full delivery
 * list. `syncOrderStatus` returns the new pair and they are stored for the next
 * tick — and only when the ERP actually sent them, so a 304 never advances a
 * cursor past a timestamp nobody published.
 *
 * Quotes are polled in the same pass. They are the other thing that moves
 * without the portal doing anything: a person at the dealer prices a scope, and
 * without this read the quote column would be a one-way outbox. It is NOT
 * conditional — `gable` publishes no ETag on `/quotes` — so it is a plain read
 * and is skipped entirely when this board holds no dealer quote.
 */
export async function refreshGableStatus(): Promise<Result<number>> {
  if (gableStore.get().status !== 'connected') return err('Not connected to the supplier.');
  if (gableStore.get().syncing) return ok(0);

  setGableState({ syncing: true });
  const deps = {
    client: gableClient(),
    nowIso: () => getContext().clock.nowIso(),
    dealerName: gableStore.get().dealer?.dealer_name ?? 'your supplier',
  };

  try {
    const state = gableStore.get();
    const result = await syncOrderStatus({
      ...deps,
      cursor: state.feedCursor ?? undefined,
      etag: state.feedEtag ?? undefined,
    });

    setGableState({
      error: null,
      feedCursor: result.cursor ?? null,
      feedEtag: result.etag ?? null,
      lastPollNotModified: result.notModified,
    });

    const quotesChanged = await syncQuotes(deps);
    return ok(result.changed + quotesChanged);
  } catch (error) {
    setGableState({ syncing: false });
    if (!(error instanceof GableAuthError)) {
      setGableState({ status: 'error', error: describeGableError(error) });
    }
    return err(describeGableError(error));
  }
}

export function startGableSync(intervalMs = GABLE_SYNC_INTERVAL_MS): void {
  stopGableSync();
  void refreshGableStatus();
  syncTimer = setInterval(() => void refreshGableStatus(), intervalMs);
}

export function stopGableSync(): void {
  if (syncTimer !== undefined) clearInterval(syncTimer);
  syncTimer = undefined;
}
