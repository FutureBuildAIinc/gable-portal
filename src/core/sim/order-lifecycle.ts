// SPDX-License-Identifier: LicenseRef-OpenLBM-Community-Source-1.0
// SPDX-FileCopyrightText: 2026 FutureBuild, Inc. and OpenLBM contributors
import { supplierName } from '../config/runtime';
import type { SalesOrder, SalesOrderStatus, TrackingEvent } from '../domain/supplier';
import { newId } from '../lib/ids';
import { rngFor } from '../lib/rng';
import { addDays, fromIso, startOfDay } from '../lib/time';
import { SIM } from './config';
import type { SimContext } from './types';

/**
 * The supplier fulfilling an order: confirm, pick, stage, run the truck,
 * deliver, bill.
 *
 * Two honesty rules shape the timing. Goods are not dispatched before the date
 * the contractor asked for — a demo where the truck arrives a week early looks
 * broken, not fast. And a will-call order parks at "ready for pickup" rather
 * than pretending someone collected it, because that is genuinely waiting on
 * the contractor.
 *
 * To keep a nine-day delivery watchable, the Demo Director skips the clock
 * forward rather than the sim skipping the calendar.
 */

const PICK_NOTES = [
  'Pulled from the Main Yard.',
  'Staged on the dock.',
  'Bundled and wrapped for transport.',
];

const TRUCK_NOTES = [
  'Loaded on truck 12.',
  'On the truck, first stop of the morning.',
  'Out with the afternoon run.',
];

function track(order: SalesOrder, status: SalesOrderStatus, note: string, at: string): SalesOrder {
  const event: TrackingEvent = { at, status, note };
  return { ...order, status, tracking: [...order.tracking, event] };
}

export function registerOrderLifecycle(ctx: SimContext): void {
  const { scheduler, clock, stores } = ctx;

  function advance(
    salesOrderId: string,
    status: SalesOrderStatus,
    note: string,
    kind: string,
    message: (so: SalesOrder) => string,
  ): SalesOrder | undefined {
    const so = stores.salesOrders.get().byId[salesOrderId];
    if (!so || so.status === 'cancelled') return undefined;

    const updated = track(so, status, note, clock.nowIso());
    stores.putSalesOrder(updated);
    ctx.log({
      actor: 'system',
      kind,
      message: message(updated),
      orderId: so.orderId,
    });
    return updated;
  }

  // Every chained step is anchored to the completed task's dueAt rather than
  // clock.now() at handler time. The two coincide while the tab is open; after
  // a day offline they differ by a day, and anchoring to now() would advance a
  // week-long fulfillment exactly one step per reload — the opposite of the
  // "it happened while you were away" contract the scheduler exists to keep.
  scheduler.on('order.confirm', ({ salesOrderId }, task) => {
    const id = String(salesOrderId);
    const so = advance(
      id,
      'confirmed',
      `Order confirmed by ${supplierName()}.`,
      'order.confirmed',
      (o) => `${o.number} confirmed by ${supplierName()}`,
    );
    if (so)
      scheduler.scheduleAt('order.pick', task.dueAt + SIM.orderPickDelay, { salesOrderId: id });
  });

  scheduler.on('order.pick', ({ salesOrderId }, task) => {
    const id = String(salesOrderId);
    const note = rngFor(ctx.seed, `pick:${id}`).pick(PICK_NOTES);
    const so = advance(id, 'picking', note, 'order.picking', (o) => `${o.number} is being picked`);
    if (so)
      scheduler.scheduleAt('order.staged', task.dueAt + SIM.orderStagedDelay, { salesOrderId: id });
  });

  scheduler.on('order.staged', ({ salesOrderId }, task) => {
    const id = String(salesOrderId);
    const so = stores.salesOrders.get().byId[id];
    if (!so || so.status === 'cancelled') return;

    if (so.fulfillment === 'willcall') {
      advance(
        id,
        'ready-willcall',
        'Ready at the Main Yard will-call counter.',
        'order.ready',
        (o) => `${o.number} is ready for pickup`,
      );
      // Parks here. Assume collection only after a generous wait — and never
      // before the pickup day the contractor actually asked for, or the sim
      // "collects" and bills goods two days before they said they'd show up.
      const promisedPickup = so.promisedDate ? fromIso(startOfDay(so.promisedDate)) : task.dueAt;
      scheduler.scheduleAt(
        'order.deliver',
        Math.max(task.dueAt + SIM.willCallAutoCollect, promisedPickup),
        { salesOrderId: id },
      );
      return;
    }

    // Never dispatch before the date they asked for.
    const readyAt = task.dueAt;
    const promised = so.promisedDate ? fromIso(startOfDay(so.promisedDate)) : readyAt;
    const dispatchAt = Math.max(readyAt, promised);
    scheduler.scheduleAt('order.dispatch', dispatchAt, { salesOrderId: id });
  });

  scheduler.on('order.dispatch', ({ salesOrderId }, task) => {
    const id = String(salesOrderId);
    const note = rngFor(ctx.seed, `truck:${id}`).pick(TRUCK_NOTES);
    const so = advance(
      id,
      'out-for-delivery',
      note,
      'order.out-for-delivery',
      (o) => `${o.number} is out for delivery`,
    );
    if (so)
      scheduler.scheduleAt('order.deliver', task.dueAt + SIM.deliveryRunDuration, {
        salesOrderId: id,
      });
  });

  scheduler.on('order.deliver', ({ salesOrderId }, task) => {
    const id = String(salesOrderId);
    const existing = stores.salesOrders.get().byId[id];
    if (!existing || existing.status === 'cancelled') return;

    const so = advance(
      id,
      'delivered',
      existing.fulfillment === 'willcall' ? 'Collected from will-call.' : 'Delivered to site.',
      'order.delivered',
      (o) =>
        o.fulfillment === 'willcall' ? `${o.number} collected` : `${o.number} delivered to site`,
    );
    if (!so) return;

    stores.putSalesOrder({ ...so, deliveredAt: clock.nowIso() });
    scheduler.scheduleAt('order.invoice', task.dueAt + SIM.invoiceDelay, { salesOrderId: id });
  });

  scheduler.on('order.invoice', ({ salesOrderId }) => {
    const id = String(salesOrderId);
    const so = stores.salesOrders.get().byId[id];
    if (!so || so.status === 'cancelled') return;

    const invoiceNumber = `INV-${9000 + stores.invoices.get().allIds.length + 1}`;
    const issuedAt = clock.nowIso();

    stores.putInvoice({
      id: newId('inv'),
      number: invoiceNumber,
      accountId: ctx.accountId,
      orderId: so.orderId,
      salesOrderId: so.id,
      origin: 'portal',
      issuedAt,
      dueAt: addDays(issuedAt, ctx.termsDays),
      subtotal: so.subtotal,
      balance: so.subtotal,
      description: so.number,
    });

    stores.putSalesOrder(track(so, 'invoiced', `Invoiced as ${invoiceNumber}.`, issuedAt));

    // The card moves itself into the Invoice column — invoicing is the
    // supplier's move, which is why the contractor cannot drag it there.
    stores.advanceOrderToInvoice(so.orderId);

    ctx.log({
      actor: 'system',
      kind: 'invoice.issued',
      message: `${invoiceNumber} issued for ${so.number}`,
      orderId: so.orderId,
    });
  });
}

export function createSalesOrder(
  ctx: SimContext,
  orderId: string,
  fulfillment: 'delivery' | 'willcall',
  subtotal: number,
  requestedDate: string | undefined,
): SalesOrder {
  const number = `SO-${5000 + ctx.stores.salesOrders.get().allIds.length + 1}`;
  const now = ctx.clock.nowIso();

  return {
    id: newId('so'),
    orderId,
    number,
    status: 'submitted',
    fulfillment,
    submittedAt: now,
    // Honour the requested date, or promise two days out if none was set.
    promisedDate: requestedDate ?? addDays(now, 2),
    subtotal,
    tracking: [{ at: now, status: 'submitted', note: `Order received by ${supplierName()}.` }],
  };
}
