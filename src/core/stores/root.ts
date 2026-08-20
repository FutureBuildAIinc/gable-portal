// SPDX-License-Identifier: LicenseRef-OpenLBM-Community-Source-1.0
// SPDX-FileCopyrightText: 2026 FutureBuild, Inc. and OpenLBM contributors
import type { Account, User } from '../domain/account';
import type { ActivityState } from '../domain/activity';
import type { Brand, Category, Location, Product } from '../domain/catalog';
import type { CustomerQuote } from '../domain/customer-quote';
import type { Payment, PaymentMethod } from '../domain/payment';
import type { Order, Project, ScopeItem } from '../domain/project';
import type { Invoice, Quote, SalesOrder } from '../domain/supplier';
import type { TeamMember } from '../domain/team';
import type { EntityId } from '../lib/ids';
import type { SimTask } from '../sim/scheduler';
import { type Collection, type Store, createStore, emptyCollection } from './store';

/**
 * The store instances. One per aggregate rather than a single god-store, so a
 * board card re-renders when its order changes and not when an unrelated
 * invoice does.
 */

export interface CatalogState {
  products: Product[];
  categories: Category[];
  brands: Brand[];
  locations: Location[];
}

export interface SessionState {
  account: Account | null;
  user: User | null;
}

/**
 * The contractor's team, plus who is acting right now. `activeId` is state,
 * not session fluff: every permission check in the actions layer reads it, and
 * it persists so an A/P person who reloads is still the A/P person.
 */
export interface TeamState {
  members: Collection<TeamMember>;
  activeId: EntityId | null;
}

export const catalogStore: Store<CatalogState> = createStore<CatalogState>({
  products: [],
  categories: [],
  brands: [],
  locations: [],
});

export const sessionStore: Store<SessionState> = createStore<SessionState>({
  account: null,
  user: null,
});

export const teamStore: Store<TeamState> = createStore<TeamState>({
  members: { byId: {}, allIds: [] },
  activeId: null,
});

/** Sim-owned state: the clock anchor and the queue of pending supplier work. */
export interface SimState {
  tasks: SimTask[];
  speed: number;
  anchorSim: number;
  anchorReal: number;
}

export const projectsStore: Store<Collection<Project>> = createStore(emptyCollection<Project>());
export const ordersStore: Store<Collection<Order>> = createStore(emptyCollection<Order>());
export const scopeStore: Store<Collection<ScopeItem>> = createStore(emptyCollection<ScopeItem>());

// Supplier-side artifacts. Written by the simulator, never by a UI action.
export const quotesStore: Store<Collection<Quote>> = createStore(emptyCollection<Quote>());
export const salesOrdersStore: Store<Collection<SalesOrder>> = createStore(
  emptyCollection<SalesOrder>(),
);
export const invoicesStore: Store<Collection<Invoice>> = createStore(emptyCollection<Invoice>());

/** The contractor's own proposals — sell side, not supplier side. */
export const customerQuotesStore: Store<Collection<CustomerQuote>> = createStore(
  emptyCollection<CustomerQuote>(),
);

export const paymentMethodsStore: Store<Collection<PaymentMethod>> = createStore(
  emptyCollection<PaymentMethod>(),
);
export const paymentsStore: Store<Collection<Payment>> = createStore(emptyCollection<Payment>());

export const activityStore: Store<ActivityState> = createStore<ActivityState>({
  entries: [],
  readWatermark: new Date(0).toISOString(),
});

export const simStore: Store<SimState> = createStore<SimState>({
  tasks: [],
  speed: 1,
  anchorSim: 0,
  anchorReal: 0,
});

/**
 * Catalog is intentionally absent: it is derived from the seed every boot and
 * would only bloat localStorage. Session is absent for the same reason in v1.
 *
 * Typed as unknown-payload stores because the list is heterogeneous; each entry
 * only ever round-trips its own JSON, so the element type is not load-bearing.
 */
export interface PersistedEntry {
  key: string;
  store: Store<unknown>;
}

export const PERSISTED_STORES: PersistedEntry[] = [
  { key: 'projects', store: projectsStore as Store<unknown> },
  { key: 'orders', store: ordersStore as Store<unknown> },
  { key: 'scope', store: scopeStore as Store<unknown> },
  { key: 'quotes', store: quotesStore as Store<unknown> },
  { key: 'salesOrders', store: salesOrdersStore as Store<unknown> },
  { key: 'invoices', store: invoicesStore as Store<unknown> },
  { key: 'customerQuotes', store: customerQuotesStore as Store<unknown> },
  { key: 'paymentMethods', store: paymentMethodsStore as Store<unknown> },
  { key: 'payments', store: paymentsStore as Store<unknown> },
  { key: 'activity', store: activityStore as Store<unknown> },
  { key: 'team', store: teamStore as Store<unknown> },
  // Persisting the queue is what lets supplier work continue across a reload.
  { key: 'sim', store: simStore as Store<unknown> },
];
