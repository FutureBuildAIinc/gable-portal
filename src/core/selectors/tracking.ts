// SPDX-License-Identifier: LicenseRef-OpenLBM-Community-Source-1.0
// SPDX-FileCopyrightText: 2026 FutureBuild, Inc. and OpenLBM contributors
import type { Order, Project } from '../domain/project';
import {
  SALES_ORDER_FLOW,
  SALES_ORDER_LABELS,
  type SalesOrder,
  type SalesOrderStatus,
} from '../domain/supplier';
import type { IsoDateTime } from '../lib/time';
import { ordersStore, projectsStore, salesOrdersStore } from '../stores/root';
import type { Collection } from '../stores/store';

/**
 * Read model for one order's fulfillment — the "where is my stuff" view.
 *
 * The step list is derived from SALES_ORDER_FLOW rather than from the tracking
 * events, so the contractor sees the whole journey including what hasn't
 * happened yet. A timeline that only shows completed events answers "what
 * happened" but not "what's left", and the second question is the one someone
 * standing on a job site is actually asking.
 */

export type StepState = 'done' | 'current' | 'upcoming';

export interface TrackingStep {
  status: SalesOrderStatus;
  label: string;
  state: StepState;
  /** When it happened, from the sales order's tracking log. */
  at?: IsoDateTime;
  /** The supplier's own words for this event. */
  note?: string;
}

export interface OrderTracking {
  order: Order;
  project: Project;
  salesOrder: SalesOrder;
  steps: TrackingStep[];
  willCall: boolean;
  promisedDate?: IsoDateTime;
  /** Promised date has passed and it still isn't here. */
  late: boolean;
  cancelled: boolean;
  /** The goods are on the counter and the contractor can say they took them. */
  canConfirmPickup: boolean;
  /** Nothing is rolling yet, so the date is still movable. */
  canReschedule: boolean;
}

/**
 * A will-call order never goes out for delivery — it parks at the counter
 * instead. Same number of steps, one substitution, so the timeline reads
 * truthfully for both fulfillment methods without a second flow constant.
 */
export function flowFor(fulfillment: SalesOrder['fulfillment']): SalesOrderStatus[] {
  if (fulfillment === 'delivery') return [...SALES_ORDER_FLOW];
  return SALES_ORDER_FLOW.map((status) =>
    status === 'out-for-delivery' ? 'ready-willcall' : status,
  );
}

/** Statuses from which a truck is already committed or the goods are gone. */
const PAST_DISPATCH: readonly SalesOrderStatus[] = [
  'out-for-delivery',
  'delivered',
  'invoiced',
] as const;

export function isDispatched(status: SalesOrderStatus): boolean {
  return PAST_DISPATCH.includes(status);
}

function hasArrived(so: SalesOrder): boolean {
  return so.deliveredAt !== undefined || so.status === 'delivered' || so.status === 'invoiced';
}

function buildSteps(so: SalesOrder): TrackingStep[] {
  const flow = flowFor(so.fulfillment);

  // First event per status: a status reached twice (a re-pick, say) should
  // timestamp when it was first reached, not when it was revisited.
  const firstEvent = new Map<SalesOrderStatus, { at: IsoDateTime; note: string }>();
  for (const event of so.tracking) {
    if (!firstEvent.has(event.status)) firstEvent.set(event.status, event);
  }

  const currentIndex = flow.indexOf(so.status);

  return flow.map((status, index) => {
    const event = firstEvent.get(status);
    // A cancelled order has no current index, so anything already logged reads
    // as done and the rest as upcoming — the timeline stops rather than lying
    // about where the order is.
    const state: StepState =
      currentIndex === -1
        ? event
          ? 'done'
          : 'upcoming'
        : index < currentIndex
          ? 'done'
          : index === currentIndex
            ? 'current'
            : 'upcoming';

    return {
      status,
      label: SALES_ORDER_LABELS[status],
      state,
      ...(event ? { at: event.at, note: event.note } : {}),
    };
  });
}

export interface BuildOrderTrackingInput {
  order: Order;
  project: Project;
  salesOrders: Collection<SalesOrder>;
  now: IsoDateTime;
}

/**
 * Returns null when there is nothing to track yet — an order still in Plan has
 * no sales order, and that is a legitimate state, not an error.
 */
export function buildOrderTracking(input: BuildOrderTrackingInput): OrderTracking | null {
  const { order, project, salesOrders, now } = input;
  const salesOrder = order.salesOrderId ? salesOrders.byId[order.salesOrderId] : undefined;
  if (!salesOrder) return null;

  const cancelled = salesOrder.status === 'cancelled';
  const arrived = hasArrived(salesOrder);
  const promised = salesOrder.promisedDate;

  return {
    order,
    project,
    salesOrder,
    steps: buildSteps(salesOrder),
    willCall: salesOrder.fulfillment === 'willcall',
    ...(promised ? { promisedDate: promised } : {}),
    late: !cancelled && !arrived && promised !== undefined && promised < now,
    cancelled,
    canConfirmPickup: salesOrder.status === 'ready-willcall',
    canReschedule: !cancelled && !isDispatched(salesOrder.status),
  };
}

/**
 * Store-reading convenience over the pure builder, for callers that just want
 * the answer — the assistant's read tools in M8, and anything outside a React
 * render. Components should subscribe and call buildOrderTracking themselves so
 * they re-render when the sales order changes.
 */
export function trackingForOrder(orderId: string, now: IsoDateTime): OrderTracking | null {
  const order = ordersStore.get().byId[orderId];
  if (!order) return null;
  const project = projectsStore.get().byId[order.projectId];
  if (!project) return null;

  return buildOrderTracking({ order, project, salesOrders: salesOrdersStore.get(), now });
}
