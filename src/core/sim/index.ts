// SPDX-License-Identifier: LicenseRef-OpenLBM-Community-Source-1.0
// SPDX-FileCopyrightText: 2026 FutureBuild, Inc. and OpenLBM contributors
import { dealerConfig, supplierName } from '../config/runtime';
import { termsDays } from '../domain/account';
import { type ActivityEntry, MAX_ACTIVITY_ENTRIES } from '../domain/activity';
import type { Order } from '../domain/project';
import { orderTotals } from '../domain/totals';
import { newId } from '../lib/ids';
import { DAY_MS, type IsoDateTime, formatDate, fromIso, startOfDay } from '../lib/time';
import {
  activityStore,
  invoicesStore,
  ordersStore,
  quotesStore,
  salesOrdersStore,
  scopeStore,
  sessionStore,
  simStore,
} from '../stores/root';
import { listOf, patch, upsert } from '../stores/store';
import type { SimClock } from './clock';
import { SIM } from './config';
import { createSalesOrder, registerOrderLifecycle } from './order-lifecycle';
import { createQuote, registerQuoteDesk } from './quote-desk';
import { type Scheduler, createScheduler } from './scheduler';
import type { SimContext, SimStores } from './types';

export interface Sim {
  scheduler: Scheduler;
  /** Called by the stage machine's submit-to-quote-desk effect. */
  submitToQuoteDesk(orderId: string): void;
  withdrawFromQuoteDesk(orderId: string): void;
  createOrderWithSupplier(order: Order): void;
  cancelWithSupplier(orderId: string): void;
  /**
   * Move a placed order's date.
   *
   * This lives here, not in `actions/fulfillment.ts`, because it is the
   * SUPPLIER's work: it re-times the dispatch and the will-call auto-collect,
   * both of which are simulator-owned scheduler tasks. The action layer keeps
   * only the guards a contractor can understand (permission, "the truck has
   * left", "that date has passed") and then asks whichever supplier is
   * installed. On the wired path the same question goes to `gable`, which
   * answers "recorded, not applied" — see `supplier/port.ts`.
   *
   * Returns null when there is nothing placed to move.
   */
  applyReschedule(orderId: string, newDate: IsoDateTime): { promisedDate: IsoDateTime } | null;
  control: SimControl;
}

export interface SimControl {
  setSpeed(multiplier: number): void;
  speed(): number;
  /** Jump straight to whatever happens next — the demo's most-used button. */
  skipToNextEvent(): boolean;
  advanceDays(days: number): void;
  pendingCount(): number;
  nextDueAt(): number | null;
}

export function createSim(clock: SimClock, seed: number): Sim {
  const scheduler = createScheduler({
    clock,
    getTasks: () => simStore.get().tasks,
    setTasks: (tasks) => simStore.set({ ...simStore.get(), tasks }),
  });

  const stores: SimStores = {
    orders: ordersStore,
    scope: scopeStore,
    quotes: quotesStore,
    salesOrders: salesOrdersStore,
    invoices: invoicesStore,

    itemsForOrder: (orderId) => listOf(scopeStore.get()).filter((i) => i.orderId === orderId),
    patchScopeItem: (id, changes) => scopeStore.set(patch(scopeStore.get(), id, changes)),
    patchQuote: (id, changes) => quotesStore.set(patch(quotesStore.get(), id, changes)),
    putSalesOrder: (so) => salesOrdersStore.set(upsert(salesOrdersStore.get(), so)),
    putInvoice: (inv) => invoicesStore.set(upsert(invoicesStore.get(), inv)),
    advanceOrderToInvoice: (orderId) => {
      const order = ordersStore.get().byId[orderId];
      if (!order || order.stage === 'invoice') return;
      ordersStore.set(
        patch(ordersStore.get(), orderId, { stage: 'invoice', updatedAt: clock.nowIso() }),
      );
    },
  };

  const account = sessionStore.get().account;

  const ctx: SimContext = {
    clock,
    scheduler,
    stores,
    seed,
    accountId: account?.id ?? 'acct_summit',
    // The dealer's configured terms win; the account's code is the fallback
    // for a deployment that has never opened the admin console.
    // `??`, not `||`: a dealer setting 0 means "due on receipt", and `||`
    // treated that deliberate choice as "unset" and silently used Net-30.
    termsDays:
      dealerConfig().supplier.termsDays ?? (account ? termsDays(account.paymentTermsCode) : 30),
    log: (entry) => appendActivity({ ...entry, id: newId('act'), at: clock.nowIso() }),
  };

  registerQuoteDesk(ctx);
  registerOrderLifecycle(ctx);

  return {
    scheduler,

    submitToQuoteDesk(orderId) {
      const quote = createQuote(ctx, orderId);
      quotesStore.set(upsert(quotesStore.get(), quote));
      ordersStore.set(patch(ordersStore.get(), orderId, { quoteId: quote.id }));

      ctx.log({
        actor: 'user',
        kind: 'quote.submitted',
        message: `Sent ${quote.number} to the ${supplierName()} quote desk`,
        orderId,
      });

      scheduler.schedule('quote.review', SIM.quoteReviewDelay, { quoteId: quote.id });
    },

    withdrawFromQuoteDesk(orderId) {
      const order = ordersStore.get().byId[orderId];
      if (!order?.quoteId) return;

      quotesStore.set(patch(quotesStore.get(), order.quoteId, { status: 'withdrawn' }));
      scheduler.cancelWhere((task) => task.payload.quoteId === order.quoteId);

      ctx.log({
        actor: 'user',
        kind: 'quote.withdrawn',
        message: 'Withdrew the order from the quote desk',
        orderId,
      });
    },

    createOrderWithSupplier(order) {
      const items = stores.itemsForOrder(order.id);
      const totals = orderTotals(items);

      const salesOrder = createSalesOrder(
        ctx,
        order.id,
        order.fulfillment,
        totals.subtotal,
        order.requestedDate,
      );

      salesOrdersStore.set(upsert(salesOrdersStore.get(), salesOrder));
      ordersStore.set(patch(ordersStore.get(), order.id, { salesOrderId: salesOrder.id }));

      ctx.log({
        actor: 'user',
        kind: 'order.submitted',
        message: `Placed ${salesOrder.number} with ${supplierName()}`,
        orderId: order.id,
      });

      scheduler.schedule('order.confirm', SIM.orderConfirmDelay, { salesOrderId: salesOrder.id });
    },

    cancelWithSupplier(orderId) {
      const order = ordersStore.get().byId[orderId];
      if (!order?.salesOrderId) return;

      const so = salesOrdersStore.get().byId[order.salesOrderId];
      if (so) {
        salesOrdersStore.set(
          patch(salesOrdersStore.get(), so.id, {
            status: 'cancelled',
            tracking: [
              ...so.tracking,
              {
                at: clock.nowIso(),
                status: 'cancelled' as const,
                note: 'Cancelled by contractor.',
              },
            ],
          }),
        );
      }
      scheduler.cancelWhere((task) => task.payload.salesOrderId === order.salesOrderId);

      ctx.log({
        actor: 'user',
        kind: 'order.cancelled',
        message: `Cancelled ${so?.number ?? 'the order'} with ${supplierName()}`,
        orderId,
      });
    },

    applyReschedule(orderId, newDate) {
      const order = ordersStore.get().byId[orderId];
      if (!order?.salesOrderId) return null;
      const salesOrder = salesOrdersStore.get().byId[order.salesOrderId];
      if (!salesOrder) return null;

      const now = clock.nowIso();
      const noun = salesOrder.fulfillment === 'willcall' ? 'Pickup' : 'Delivery';

      salesOrdersStore.set(
        patch(salesOrdersStore.get(), salesOrder.id, {
          promisedDate: newDate,
          tracking: [
            ...salesOrder.tracking,
            {
              at: now,
              status: salesOrder.status,
              note: `${noun} moved to ${formatDate(newDate)} at your request.`,
            },
          ],
        }),
      );
      ordersStore.set(
        patch(ordersStore.get(), orderId, { requestedDate: newDate, updatedAt: now }),
      );

      // If the goods are already staged, the dispatch moment was fixed when
      // they were picked. Re-time it, or the new date would be cosmetic and the
      // truck would leave on the old one.
      const retimed = scheduler.cancelWhere(
        (task) => task.type === 'order.dispatch' && task.payload.salesOrderId === salesOrder.id,
      );
      if (retimed > 0) {
        // Same rule the sim uses elsewhere: never roll before the requested day.
        scheduler.scheduleAt(
          'order.dispatch',
          Math.max(clock.now(), fromIso(startOfDay(newDate))),
          { salesOrderId: salesOrder.id },
        );
      }

      // A will-call's future is an auto-collect, not a dispatch — and it was
      // timed off the old pickup date. Without re-timing it, "pickup moved to
      // Friday" would still get collected and billed on Wednesday.
      const collectRetimed = scheduler.cancelWhere(
        (task) => task.type === 'order.deliver' && task.payload.salesOrderId === salesOrder.id,
      );
      if (collectRetimed > 0 && salesOrder.fulfillment === 'willcall') {
        scheduler.scheduleAt(
          'order.deliver',
          Math.max(clock.now(), fromIso(startOfDay(newDate)) + DAY_MS / 2),
          { salesOrderId: salesOrder.id },
        );
      }

      ctx.log({
        actor: 'user',
        kind: 'order.rescheduled',
        message: `${noun} for ${salesOrder.number} moved to ${formatDate(newDate)}`,
        orderId,
      });

      return { promisedDate: newDate };
    },

    control: {
      setSpeed: (multiplier) => {
        clock.setSpeed(multiplier);
        // Persist the WHOLE anchor, not just the speed. setSpeed re-anchors the
        // in-memory clock; persisting {old anchor, new speed} and reloading
        // within the 2s reconcile window replays the anchor gap at the new
        // multiplier — a 30-minute-old anchor at 3600x is ~75 days of sim time,
        // and the catch-up pump then mass-fires every pending task.
        simStore.set({ ...simStore.get(), ...clock.snapshot() });
      },
      speed: () => clock.speed(),

      skipToNextEvent() {
        const next = scheduler.nextDueAt();
        if (next === null) return false;
        // +1s so the task is unambiguously due rather than exactly on the boundary.
        clock.advance(Math.max(0, next - clock.now()) + 1000);
        simStore.set({ ...simStore.get(), ...clock.snapshot() });
        scheduler.pump();
        return true;
      },

      advanceDays(days) {
        clock.advance(days * DAY_MS);
        simStore.set({ ...simStore.get(), ...clock.snapshot() });
        scheduler.pump();
      },

      pendingCount: () => scheduler.tasks().length,
      nextDueAt: () => scheduler.nextDueAt(),
    },
  };
}

function appendActivity(entry: ActivityEntry): void {
  const state = activityStore.get();
  activityStore.set({
    ...state,
    entries: [entry, ...state.entries].slice(0, MAX_ACTIVITY_ENTRIES),
  });
}
