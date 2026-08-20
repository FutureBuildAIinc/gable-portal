// SPDX-License-Identifier: LicenseRef-OpenLBM-Community-Source-1.0
// SPDX-FileCopyrightText: 2026 FutureBuild, Inc. and OpenLBM contributors
import type { ActivityEntry } from '../domain/activity';
import type { ScopeItem } from '../domain/project';
import type { Order } from '../domain/project';
import type { Invoice, Quote, SalesOrder } from '../domain/supplier';
import type { Collection, Store } from '../stores/store';
import type { SimClock } from './clock';
import type { Scheduler } from './scheduler';

/**
 * What a sim handler is allowed to touch.
 *
 * Handlers get a narrow façade rather than the stores directly. The point is
 * that the simulator writes supplier-side facts — a quote came back, a truck
 * left — and must not reach for the contractor's actions, which carry guards
 * meant for a human. `advanceOrderToInvoice` is deliberately the only stage
 * change exposed, because it's the only one the supplier makes.
 */
export interface SimStores {
  orders: Store<Collection<Order>>;
  scope: Store<Collection<ScopeItem>>;
  quotes: Store<Collection<Quote>>;
  salesOrders: Store<Collection<SalesOrder>>;
  invoices: Store<Collection<Invoice>>;

  itemsForOrder(orderId: string): ScopeItem[];
  patchScopeItem(itemId: string, changes: Partial<ScopeItem>): void;
  patchQuote(quoteId: string, changes: Partial<Quote>): void;
  putSalesOrder(salesOrder: SalesOrder): void;
  putInvoice(invoice: Invoice): void;
  advanceOrderToInvoice(orderId: string): void;
}

export interface SimContext {
  clock: SimClock;
  scheduler: Scheduler;
  stores: SimStores;
  seed: number;
  accountId: string;
  termsDays: number;
  log(entry: Omit<ActivityEntry, 'id' | 'at'>): void;
}
