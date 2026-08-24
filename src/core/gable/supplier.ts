// SPDX-License-Identifier: LicenseRef-OpenLBM-Community-Source-1.0
// SPDX-FileCopyrightText: 2026 FutureBuild, Inc. and OpenLBM contributors
import { type ActivityEntry, MAX_ACTIVITY_ENTRIES } from '../domain/activity';
import type { Order, ScopeItem } from '../domain/project';
import type { Quote, SalesOrder } from '../domain/supplier';
import { newId } from '../lib/ids';
import type { IsoDateTime } from '../lib/time';
import {
  activityStore,
  ordersStore,
  quotesStore,
  salesOrdersStore,
  scopeStore,
} from '../stores/root';
import { listOf, patch, remove, upsert } from '../stores/store';
import type { SupplierPort } from '../supplier/port';
import type { GableClient } from './client';
import { describeGableError } from './errors';
import { salesOrderFrom, salesOrderIdFor } from './mapper';
import { setGableState } from './store';

/**
 * The real supplier: a running `gable`, reached over HTTP.
 *
 * Read `supplier/port.ts` first — it explains why every method here returns
 * `void` while the work behind it is asynchronous. The consequence is the
 * design of `createOrderWithSupplier`: it writes an optimistic, clearly-labelled
 * placeholder synchronously so the board card has something true to show, then
 * either replaces it with the real ERP order or **undoes the stage move** if
 * the ERP refuses. Leaving a card sitting in Order with no order behind it is
 * the exact class of lie this integration is correcting.
 *
 * Two of the four port methods have no `gable` endpoint behind them at all, and
 * they say so out loud rather than simulating:
 *
 *  - **Quote desk.** `gable`'s portal API has no quote resource. The Quote
 *    stage still works — the local `Quote` record is created so the stage
 *    machine's guards keep holding — but nothing is sent anywhere and the
 *    activity entry says so. `hasQuoteDesk` is false so the UI can label it.
 *  - **Cancellation.** There is no `POST /orders/{id}/cancel`. The portal
 *    records that it could not cancel, leaves the ERP order untouched, and
 *    tells the contractor to call the yard. It does NOT flip the local record
 *    to `cancelled`, because that would show a cancellation the dealer never
 *    made.
 *
 * Both are listed as missing endpoints in ROADMAP §1.
 */

export interface GableSupplierDeps {
  client: GableClient;
  /** Sim time is the app's clock everywhere; the ERP path uses it too so
   *  timestamps on a board are comparable regardless of which side wrote them. */
  nowIso: () => IsoDateTime;
  /** The dealer's configured name, for contractor-facing sentences. */
  dealerName: string;
}

/** Placeholder id while the ERP has not answered yet. Derived, so it is findable. */
export function pendingSalesOrderIdFor(orderId: string): string {
  return `gso_pending_${orderId}`;
}

function log(entry: Omit<ActivityEntry, 'id' | 'at'>, at: IsoDateTime): void {
  const state = activityStore.get();
  activityStore.set({
    ...state,
    entries: [{ ...entry, id: newId('act'), at }, ...state.entries].slice(0, MAX_ACTIVITY_ENTRIES),
  });
}

function itemsFor(orderId: string): ScopeItem[] {
  return listOf(scopeStore.get()).filter((item) => item.orderId === orderId);
}

export function createGableSupplier(deps: GableSupplierDeps): SupplierPort {
  const { client, nowIso, dealerName } = deps;

  /**
   * Undo a stage move the ERP would not honour.
   *
   * The board already moved the card when this runs — `moveOrderToStage`
   * applies the stage change before dispatching effects, so the simulator sees
   * the order in its new state. When the far side refuses, the card has to go
   * back, or the contractor is looking at an order that does not exist.
   */
  function rollback(orderId: string, to: Order['stage'], reason: string): void {
    const at = nowIso();
    salesOrdersStore.set(remove(salesOrdersStore.get(), pendingSalesOrderIdFor(orderId)));

    const order = ordersStore.get().byId[orderId];
    if (order) {
      const { salesOrderId: _dropped, ...withoutSalesOrder } = order;
      ordersStore.set(
        upsert(ordersStore.get(), { ...withoutSalesOrder, stage: to, updatedAt: at }),
      );
    }

    log(
      {
        actor: 'system',
        kind: 'order.rejected',
        message: `${dealerName} did not accept this order: ${reason}`,
        orderId,
      },
      at,
    );
    setGableState({ status: 'error', error: reason });
  }

  async function submit(order: Order, items: readonly ScopeItem[]): Promise<void> {
    /**
     * The ERP cart is per-customer and persistent — it survives a reload, a
     * different browser, and a previous half-finished session. Checking out
     * without clearing it first would silently attach someone else's abandoned
     * lines to this order, which is a real bug and not a theoretical one.
     */
    const existing = await client.cart();
    for (const item of existing.items ?? []) {
      await client.removeCartItem(item.id);
    }

    for (const item of items) {
      // Guarded by the caller: every item reaching here is a catalog line with
      // a productId that came from the ERP's own catalog.
      await client.addCartItem(String(item.productId), item.qty);
    }

    const checkout = await client.checkout({
      delivery_method: order.fulfillment === 'willcall' ? 'PICKUP' : 'DELIVERY',
      delivery_address: order.siteInstructions ?? '',
      // The portal has no card-payment path against the ERP; everything goes on
      // the contractor's account, which is what a trade portal means by "order".
      payment_method: 'ACCOUNT',
      notes: order.poNumber ? `PO ${order.poNumber} — ${order.name}` : order.name,
    });

    const placed = await client.order(checkout.order_id);
    const at = nowIso();

    salesOrdersStore.set(remove(salesOrdersStore.get(), pendingSalesOrderIdFor(order.id)));
    const salesOrder = salesOrderFrom({
      orderId: order.id,
      salesOrderId: salesOrderIdFor(placed.id),
      dto: placed,
      fulfillment: order.fulfillment,
      observedAt: at,
      dealerName,
    });
    salesOrdersStore.set(upsert(salesOrdersStore.get(), salesOrder));
    ordersStore.set(patch(ordersStore.get(), order.id, { salesOrderId: salesOrder.id }));

    log(
      {
        actor: 'system',
        kind: 'order.submitted',
        message: `Placed ${salesOrder.number} with ${dealerName}. It is now in their ERP.`,
        orderId: order.id,
      },
      at,
    );
    setGableState({ status: 'connected', error: null, lastSyncAt: at });
  }

  return {
    kind: 'gable',
    /** `gable` exposes no quote endpoint. Stated, not simulated. */
    hasQuoteDesk: false,

    submitToQuoteDesk(orderId) {
      const at = nowIso();
      /**
       * A local record only. It exists so `domain/stage.ts` keeps its
       * invariants — an order in Quote must have a `quoteId` — and so a
       * contractor can see what they asked for. Nothing was sent.
       */
      const quote: Quote = {
        id: newId('q'),
        orderId,
        number: `LOCAL-${newId('q').slice(-6).toUpperCase()}`,
        status: 'submitted',
        submittedAt: at,
        // Deliberately no expiry: an expiry implies a price is being held, and
        // no one at the dealer has seen this.
        linePrices: [],
        deskNote: `Portal-local. This portal cannot send a quote request to ${dealerName}'s system — their ERP exposes no quote-desk endpoint.`,
      };
      quotesStore.set(upsert(quotesStore.get(), quote));
      ordersStore.set(patch(ordersStore.get(), orderId, { quoteId: quote.id }));

      log(
        {
          actor: 'system',
          kind: 'quote.local-only',
          message: `Saved this scope for pricing. ${dealerName}'s ERP has no quote desk this portal can reach — call your rep for a number on the special-order lines.`,
          orderId,
        },
        at,
      );
    },

    withdrawFromQuoteDesk(orderId) {
      const order = ordersStore.get().byId[orderId];
      if (!order?.quoteId) return;
      quotesStore.set(patch(quotesStore.get(), order.quoteId, { status: 'withdrawn' }));
      log(
        {
          actor: 'user',
          kind: 'quote.withdrawn',
          message: 'Withdrew this scope from pricing. Nothing had been sent to the ERP.',
          orderId,
        },
        nowIso(),
      );
    },

    createOrderWithSupplier(order, from) {
      const items = itemsFor(order.id);
      const at = nowIso();

      /**
       * A special-order line has no ERP product id — that is what "special"
       * means. `gable`'s cart takes a `product_id` and nothing else, so there
       * is no way to put one on a real order. Refuse before touching the ERP
       * rather than half-submitting a package that is missing its custom door.
       */
      const special = items.filter((item) => item.kind !== 'catalog' || !item.productId);
      if (special.length > 0) {
        rollback(
          order.id,
          from,
          `${special.length} special-order line${special.length === 1 ? '' : 's'} cannot be sent — the ERP order API takes catalog products only.`,
        );
        return;
      }
      if (items.length === 0) {
        rollback(order.id, from, 'there is nothing on this order to send.');
        return;
      }

      // Optimistic, and labelled as such. `submitted` is the truthful state:
      // the contractor has committed, the ERP has not answered.
      const placeholder: SalesOrder = {
        id: pendingSalesOrderIdFor(order.id),
        orderId: order.id,
        number: 'Sending…',
        status: 'submitted',
        fulfillment: order.fulfillment,
        submittedAt: at,
        subtotal: items.reduce((sum, item) => sum + (item.unitPrice ?? 0) * item.qty, 0),
        tracking: [{ at, status: 'submitted', note: `Sending to ${dealerName}'s ERP…` }],
      };
      salesOrdersStore.set(upsert(salesOrdersStore.get(), placeholder));
      ordersStore.set(patch(ordersStore.get(), order.id, { salesOrderId: placeholder.id }));

      void submit(order, items).catch((error: unknown) => {
        rollback(order.id, from, describeGableError(error));
      });
    },

    cancelWithSupplier(orderId) {
      const at = nowIso();
      const order = ordersStore.get().byId[orderId];
      const salesOrder = order?.salesOrderId
        ? salesOrdersStore.get().byId[order.salesOrderId]
        : undefined;

      const note = `This portal cannot cancel an order in ${dealerName}'s ERP — there is no cancel endpoint. The order still stands. Call the yard.`;

      if (salesOrder) {
        // Status is UNCHANGED on purpose. Showing `cancelled` here would be the
        // portal asserting something about the ERP that is not true.
        salesOrdersStore.set(
          patch(salesOrdersStore.get(), salesOrder.id, {
            tracking: [...salesOrder.tracking, { at, status: salesOrder.status, note }],
          }),
        );
      }

      log({ actor: 'system', kind: 'order.cancel-unsupported', message: note, orderId }, at);
    },
  };
}

/**
 * Kept next to the supplier because it is the same contract read backwards:
 * the ERP is the source of order state, so the portal asks rather than ages.
 *
 * Returns the number of board orders whose supplier record changed, so a caller
 * can decide whether the refresh was worth announcing.
 */
export async function syncOrderStatus(deps: GableSupplierDeps): Promise<number> {
  const { client, nowIso } = deps;
  const at = nowIso();

  const [orders, deliveries] = await Promise.all([client.orders(), client.deliveries()]);
  const deliveryByOrder = new Map(deliveries.map((delivery) => [delivery.order_id, delivery]));

  // Only ERP orders this portal actually placed are reflected on the board. A
  // customer's order history includes counter sales and phone orders that have
  // no board card, and inventing cards for them would rewrite the contractor's
  // own project structure.
  const boardByGableId = new Map<string, string>();
  for (const salesOrder of listOf(salesOrdersStore.get())) {
    if (salesOrder.id.startsWith('gso_') && !salesOrder.id.startsWith('gso_pending_')) {
      boardByGableId.set(salesOrder.id.slice('gso_'.length), salesOrder.orderId);
    }
  }

  let changed = 0;
  for (const dto of orders) {
    const boardOrderId = boardByGableId.get(dto.id);
    if (!boardOrderId) continue;

    const previous = salesOrdersStore.get().byId[salesOrderIdFor(dto.id)];
    const next = salesOrderFrom({
      orderId: boardOrderId,
      salesOrderId: salesOrderIdFor(dto.id),
      dto,
      delivery: deliveryByOrder.get(dto.id),
      fulfillment: previous?.fulfillment ?? 'delivery',
      observedAt: at,
      dealerName: deps.dealerName,
    });

    /**
     * Deduplicate on what the ERP SAID, not on what the portal rounded it to.
     *
     * Comparing mapped statuses alone hid a real transition: `gable` moving an
     * order CONFIRMED -> ON_HOLD both map to `confirmed`, so the poll saw "no
     * change" and the contractor never learned their order had been held. The
     * tracking note carries the raw ERP word, so comparing notes catches it.
     */
    const previousNote = previous?.tracking.at(-1)?.note;
    const nextNote = next.tracking[0]?.note;
    if (
      previous?.status === next.status &&
      previous.subtotal === next.subtotal &&
      previousNote === nextNote
    ) {
      continue;
    }

    // Keep the history the portal has observed rather than replacing it with a
    // single point — this is the only order log that exists, since `gable`
    // publishes none.
    salesOrdersStore.set(
      upsert(salesOrdersStore.get(), {
        ...next,
        tracking: [...(previous?.tracking ?? []), ...next.tracking],
      }),
    );
    changed += 1;
  }

  setGableState({ lastSyncAt: at, syncing: false });
  return changed;
}
