// SPDX-License-Identifier: LicenseRef-OpenLBM-Community-Source-1.0
// SPDX-FileCopyrightText: 2026 FutureBuild, Inc. and OpenLBM contributors
import { getContext } from '../boot';
import { supplierName } from '../config/runtime';
import { MAX_ACTIVITY_ENTRIES } from '../domain/activity';
import type { Order } from '../domain/project';
import { SALES_ORDER_LABELS, type SalesOrder, type TrackingEvent } from '../domain/supplier';
import { newId } from '../lib/ids';
import { type Result, err, ok } from '../lib/result';
import { DAY_MS, type IsoDateTime, formatDate, fromIso, startOfDay } from '../lib/time';
import { isDispatched } from '../selectors/tracking';
import { SIM } from '../sim/config';
import { activityStore, ordersStore, salesOrdersStore } from '../stores/root';
import { patch } from '../stores/store';
import { requireCapability } from './team';

/**
 * What a contractor can still do to an order the supplier already has.
 *
 * Everything here is bounded by physical reality rather than by permissions:
 * you can move a date until the truck is loaded, you can rewrite the gate code
 * until the driver leaves with it, and you can tell us you collected your
 * will-call only once it is actually on the counter. Each guard returns the
 * sentence the contractor sees, because a bare "not allowed" teaches nothing
 * about when it *will* be allowed.
 */

const MAX_SITE_INSTRUCTIONS = 400;

function log(kind: string, message: string, orderId: string, actor: 'user' | 'system' = 'user') {
  const state = activityStore.get();
  activityStore.set({
    ...state,
    entries: [
      { id: newId('act'), at: getContext().clock.nowIso(), actor, kind, message, orderId },
      ...state.entries,
    ].slice(0, MAX_ACTIVITY_ENTRIES),
  });
}

interface Live {
  order: Order;
  salesOrder: SalesOrder;
}

/** Resolves the order and the supplier's live copy of it, or the reason there isn't one. */
function liveOrder(orderId: string): Result<Live> {
  const order = ordersStore.get().byId[orderId];
  if (!order) return err('That order no longer exists.');
  if (!order.salesOrderId) {
    return err(`This order hasn't been placed with ${supplierName()} yet.`);
  }

  const salesOrder = salesOrdersStore.get().byId[order.salesOrderId];
  if (!salesOrder) return err(`This order hasn't been placed with ${supplierName()} yet.`);
  if (salesOrder.status === 'cancelled') return err(`${salesOrder.number} was cancelled.`);

  return ok({ order, salesOrder });
}

function withEvent(so: SalesOrder, event: TrackingEvent): SalesOrder {
  return { ...so, status: event.status, tracking: [...so.tracking, event] };
}

/**
 * "I've got it." Only meaningful once the yard says it's on the counter.
 *
 * The sim parks a will-call at ready-willcall and assumes collection after two
 * days; confirming here short-circuits that. The pending auto-collect task is
 * cancelled and billing is scheduled in its place, so the contractor doesn't
 * get a second "collected" event two days after they drove away with it.
 */
export function confirmWillCallPickup(orderId: string): Result<SalesOrder> {
  const gate = requireCapability('confirm-pickup');
  if (!gate.ok) return gate;

  const resolved = liveOrder(orderId);
  if (!resolved.ok) return resolved;
  const { salesOrder } = resolved.value;

  if (salesOrder.fulfillment !== 'willcall') {
    return err(`${salesOrder.number} is coming to you on a truck — there's nothing to collect.`);
  }
  if (salesOrder.status === 'delivered' || salesOrder.status === 'invoiced') {
    return err(`${salesOrder.number} is already marked as collected.`);
  }
  if (salesOrder.status !== 'ready-willcall') {
    return err(
      `${salesOrder.number} isn't on the counter yet — it's still ${SALES_ORDER_LABELS[
        salesOrder.status
      ].toLowerCase()}. We'll tell you the moment it's ready.`,
    );
  }

  const { clock, sim } = getContext();
  const now = clock.nowIso();

  const updated: SalesOrder = {
    ...withEvent(salesOrder, {
      at: now,
      status: 'delivered',
      note: 'Collected from will-call.',
    }),
    deliveredAt: now,
  };
  salesOrdersStore.set(patch(salesOrdersStore.get(), salesOrder.id, updated));

  sim.scheduler.cancelWhere(
    (task) => task.type === 'order.deliver' && task.payload.salesOrderId === salesOrder.id,
  );
  sim.scheduler.schedule('order.invoice', SIM.invoiceDelay, { salesOrderId: salesOrder.id });

  log('order.collected', `You collected ${salesOrder.number} from will-call`, orderId);
  return ok(updated);
}

export interface RescheduleResult {
  order: Order;
  salesOrder: SalesOrder;
}

/**
 * Move the date. Allowed right up until the goods are on a truck — after that
 * the answer has to be no, because the truck is already rolling and a portal
 * that pretends otherwise sends someone to an empty site.
 */
export function requestDeliveryReschedule(
  orderId: string,
  newDate: IsoDateTime,
): Result<RescheduleResult> {
  const gate = requireCapability('edit-scope');
  if (!gate.ok) return gate;

  const resolved = liveOrder(orderId);
  if (!resolved.ok) return resolved;
  const { order, salesOrder } = resolved.value;

  if (isDispatched(salesOrder.status)) {
    return err(
      salesOrder.status === 'out-for-delivery'
        ? `${salesOrder.number} is already on the truck and can't be moved. Call your rep to redirect it.`
        : `${salesOrder.number} has already been ${SALES_ORDER_LABELS[salesOrder.status].toLowerCase()}.`,
    );
  }

  const requested = fromIso(newDate);
  if (Number.isNaN(requested)) return err('Pick a date.');

  const { clock, sim } = getContext();
  const now = clock.nowIso();
  if (startOfDay(newDate) < startOfDay(now)) {
    return err("Pick a date that hasn't already passed.");
  }

  const noun = salesOrder.fulfillment === 'willcall' ? 'Pickup' : 'Delivery';
  const updatedSalesOrder: SalesOrder = {
    ...withEvent(salesOrder, {
      at: now,
      status: salesOrder.status,
      note: `${noun} moved to ${formatDate(newDate)} at your request.`,
    }),
    promisedDate: newDate,
  };
  salesOrdersStore.set(patch(salesOrdersStore.get(), salesOrder.id, updatedSalesOrder));

  const updatedOrder: Order = { ...order, requestedDate: newDate, updatedAt: now };
  ordersStore.set(patch(ordersStore.get(), orderId, updatedOrder));

  // If the goods are already staged, the dispatch moment was fixed when they
  // were picked. Re-time it, or the new date would be cosmetic and the truck
  // would leave on the old one.
  const retimed = sim.scheduler.cancelWhere(
    (task) => task.type === 'order.dispatch' && task.payload.salesOrderId === salesOrder.id,
  );
  if (retimed > 0) {
    // Same rule the sim uses: never roll before the requested day.
    const dispatchAt = Math.max(clock.now(), fromIso(startOfDay(newDate)));
    sim.scheduler.scheduleAt('order.dispatch', dispatchAt, { salesOrderId: salesOrder.id });
  }

  // A will-call's future is an auto-collect, not a dispatch — and it was timed
  // off the old pickup date. Without re-timing it, "pickup moved to Friday"
  // would still get collected and billed on Wednesday.
  const collectRetimed = sim.scheduler.cancelWhere(
    (task) => task.type === 'order.deliver' && task.payload.salesOrderId === salesOrder.id,
  );
  if (collectRetimed > 0 && salesOrder.fulfillment === 'willcall') {
    const collectAt = Math.max(clock.now(), fromIso(startOfDay(newDate)) + DAY_MS / 2);
    sim.scheduler.scheduleAt('order.deliver', collectAt, { salesOrderId: salesOrder.id });
  }

  log(
    'order.rescheduled',
    `${noun} for ${salesOrder.number} moved to ${formatDate(newDate)}`,
    orderId,
  );

  return ok({ order: updatedOrder, salesOrder: updatedSalesOrder });
}

/**
 * Gate codes, where to stack it, which neighbour not to block. Editable while
 * an order is still being planned, and right up until the driver leaves with
 * the manifest.
 */
export function updateSiteInstructions(orderId: string, text: string): Result<Order> {
  const gate = requireCapability('edit-scope');
  if (!gate.ok) return gate;

  const order = ordersStore.get().byId[orderId];
  if (!order) return err('That order no longer exists.');

  const trimmed = text.trim();
  if (trimmed.length > MAX_SITE_INSTRUCTIONS) {
    return err(
      `Keep site notes under ${MAX_SITE_INSTRUCTIONS} characters — the driver reads this on a handheld.`,
    );
  }

  const salesOrder = order.salesOrderId
    ? salesOrdersStore.get().byId[order.salesOrderId]
    : undefined;
  if (salesOrder && isDispatched(salesOrder.status)) {
    return err(
      "The truck has already left with the current notes, so a change won't reach the driver. Call your rep instead.",
    );
  }

  const { clock } = getContext();
  const changed = trimmed !== (order.siteInstructions ?? '');
  const updated: Order = { ...order, siteInstructions: trimmed, updatedAt: clock.nowIso() };
  ordersStore.set(patch(ordersStore.get(), orderId, updated));

  // Worth an event only once the supplier is holding the order — before that
  // nobody on their side is reading it.
  if (changed && salesOrder) {
    salesOrdersStore.set(
      patch(salesOrdersStore.get(), salesOrder.id, {
        tracking: [
          ...salesOrder.tracking,
          {
            at: clock.nowIso(),
            status: salesOrder.status,
            note: trimmed
              ? 'Site instructions updated by the contractor.'
              : 'Site instructions cleared by the contractor.',
          },
        ],
      }),
    );
    log('order.site-instructions', `Site notes updated for ${salesOrder.number}`, orderId);
  }

  return ok(updated);
}
