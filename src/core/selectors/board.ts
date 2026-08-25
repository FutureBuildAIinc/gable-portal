// SPDX-License-Identifier: LicenseRef-OpenLBM-Community-Source-1.0
// SPDX-FileCopyrightText: 2026 FutureBuild, Inc. and OpenLBM contributors
import type { Order, OrderStage, Project, ScopeItem } from '../domain/project';
import { ORDER_STAGES } from '../domain/project';
import { allowedTargets } from '../domain/stage';
import { type Quote, SALES_ORDER_LABELS, type SalesOrder } from '../domain/supplier';
import { type OrderTotals, orderTotals } from '../domain/totals';
import type { Cents } from '../lib/money';
import type { Collection } from '../stores/store';
import { listOf } from '../stores/store';
import { ASSUMED_SPECIAL_LEAD_DAYS } from './order';

/**
 * Read models for the board. Pure functions over store snapshots, so the same
 * shapes feed the UI today and the AI's read tools later.
 */

/** Everything a board card needs, assembled once so the card component stays dumb. */
export interface BoardCard {
  order: Order;
  project: Project;
  totals: OrderTotals;
  /** Stages this card may legally move to right now — drives drop-target highlighting. */
  allowedTargets: OrderStage[];
  /** Up to three product photos from the frozen snapshots — a card you can
   *  recognise without reading. Selections first; commodities fill in. */
  thumbUrls: string[];
  /** Lead time of the slowest line, for delivery-date risk. */
  maxLeadTimeDays: number;
  /**
   * What the supplier is doing right now, if anything. This is what makes the
   * board feel live: a card in Quote reads "Being priced" then "Priced", and a
   * card in Order reads "Out for delivery" without the contractor opening it.
   */
  supplierStatus?: string;
  /** Set when the supplier has finished something needing attention. */
  supplierDone?: boolean;
}

function supplierStatusFor(
  order: Order,
  quotes: Collection<Quote>,
  salesOrders: Collection<SalesOrder>,
): { label: string; done: boolean } | undefined {
  if (order.salesOrderId) {
    const so = salesOrders.byId[order.salesOrderId];
    if (so && so.status !== 'cancelled') {
      return {
        label: SALES_ORDER_LABELS[so.status],
        done: so.status === 'delivered' || so.status === 'ready-willcall',
      };
    }
  }
  if (order.quoteId) {
    const quote = quotes.byId[order.quoteId];
    if (quote && quote.status !== 'withdrawn') {
      switch (quote.status) {
        case 'submitted':
          return { label: 'Sent to quote desk', done: false };
        case 'in-review':
          return { label: 'Being priced', done: false };
        case 'priced':
          return { label: 'Priced — ready to order', done: true };
      }
    }
  }
  return undefined;
}

export interface StageColumn {
  stage: OrderStage;
  cards: BoardCard[];
  total: Cents;
}

export function buildBoardCards(
  orders: Collection<Order>,
  projects: Collection<Project>,
  scope: Collection<ScopeItem>,
  quotes: Collection<Quote> = { byId: {}, allIds: [] },
  salesOrders: Collection<SalesOrder> = { byId: {}, allIds: [] },
  now: string = new Date(0).toISOString(),
): BoardCard[] {
  const allItems = listOf(scope);
  const itemsByOrder = new Map<string, ScopeItem[]>();
  for (const item of allItems) {
    const bucket = itemsByOrder.get(item.orderId);
    if (bucket) bucket.push(item);
    else itemsByOrder.set(item.orderId, [item]);
  }

  const cards: BoardCard[] = [];
  for (const order of listOf(orders)) {
    const project = projects.byId[order.projectId];
    if (!project || project.archivedAt) continue;

    const items = itemsByOrder.get(order.id) ?? [];

    const thumbUrls: string[] = [];
    for (const item of [...items].sort((a, b) => a.sortOrder - b.sortOrder)) {
      const url = item.snapshot.imageUrl;
      if (url && !thumbUrls.includes(url)) thumbUrls.push(url);
      if (thumbUrls.length === 3) break;
    }

    // The longest lead time anyone has actually published for this order.
    // A line with none contributes nothing — it cannot lengthen a maximum it
    // has no number for, and inventing one would light the card's lead-time
    // risk flag on a guess. `buildOrderDetail` draws the same line and for the
    // same reason; see `ASSUMED_SPECIAL_LEAD_DAYS`.
    let maxLeadTimeDays = 0;
    for (const item of items) {
      const lead =
        item.snapshot.leadTimeDays ?? (item.kind === 'special' ? ASSUMED_SPECIAL_LEAD_DAYS : 0);
      if (lead > maxLeadTimeDays) maxLeadTimeDays = lead;
    }

    const supplier = supplierStatusFor(order, quotes, salesOrders);

    cards.push({
      order,
      project,
      totals: orderTotals(items, now),
      thumbUrls,
      allowedTargets: allowedTargets(order, {
        items,
        now,
        supplierStatus: order.salesOrderId
          ? salesOrders.byId[order.salesOrderId]?.status
          : undefined,
      }),
      maxLeadTimeDays,
      ...(supplier ? { supplierStatus: supplier.label, supplierDone: supplier.done } : {}),
    });
  }

  return cards;
}

export function groupByStage(cards: readonly BoardCard[]): StageColumn[] {
  return ORDER_STAGES.map((stage) => {
    const inStage = cards
      .filter((card) => card.order.stage === stage)
      .sort((a, b) => a.order.sortOrder - b.order.sortOrder);

    return {
      stage,
      cards: inStage,
      total: inStage.reduce((sum, card) => sum + card.totals.subtotal, 0),
    };
  });
}

/** All of one project's orders, across every stage — the drill-down view. */
export function cardsForProject(cards: readonly BoardCard[], projectId: string): BoardCard[] {
  return cards
    .filter((card) => card.project.id === projectId)
    .sort((a, b) => ORDER_STAGES.indexOf(a.order.stage) - ORDER_STAGES.indexOf(b.order.stage));
}

export interface ProjectSummary {
  project: Project;
  cards: BoardCard[];
  total: Cents;
  /** Which stages this project currently has orders in. */
  stages: OrderStage[];
}

export function buildProjectSummaries(cards: readonly BoardCard[]): ProjectSummary[] {
  const byProject = new Map<string, BoardCard[]>();
  for (const card of cards) {
    const bucket = byProject.get(card.project.id);
    if (bucket) bucket.push(card);
    else byProject.set(card.project.id, [card]);
  }

  return [...byProject.values()]
    .map((group) => {
      const first = group[0] as BoardCard;
      return {
        project: first.project,
        cards: group,
        total: group.reduce((sum, card) => sum + card.totals.subtotal, 0),
        stages: ORDER_STAGES.filter((stage) => group.some((card) => card.order.stage === stage)),
      };
    })
    .sort((a, b) => a.project.name.localeCompare(b.project.name));
}
