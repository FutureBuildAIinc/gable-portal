// SPDX-License-Identifier: LicenseRef-OpenLBM-Community-Source-1.0
// SPDX-FileCopyrightText: 2026 FutureBuild, Inc. and OpenLBM contributors
import { type ActivityEntry, MAX_ACTIVITY_ENTRIES } from '../domain/activity';
import type { Uom } from '../domain/catalog';
import type { Order, ScopeItem } from '../domain/project';
import type { Quote, QuoteStatus, SalesOrder } from '../domain/supplier';
import { newId } from '../lib/ids';
import { toCents } from '../lib/money';
import { type Result, err, ok } from '../lib/result';
import type { IsoDateTime } from '../lib/time';
import {
  activityStore,
  ordersStore,
  quotesStore,
  salesOrdersStore,
  scopeStore,
} from '../stores/root';
import { listOf, patch, remove, upsert } from '../stores/store';
import type {
  QuoteDecision,
  RescheduleOutcome,
  SupplierCapabilities,
  SupplierPort,
} from '../supplier/port';
import type { GableClient } from './client';
import { describeRefusal, refusalCodeOf } from './errors';
import { salesOrderFrom, salesOrderIdFor } from './mapper';
import type { GableQuote, GableQuoteRequestLine } from './schema';
import { setGableState } from './store';

/**
 * The real supplier: a running `gable`, reached over HTTP.
 *
 * Read `supplier/port.ts` first — it explains why the four stage effects return
 * `void` while the work behind them is asynchronous. The consequence is the
 * design of `createOrderWithSupplier`: it writes an optimistic, clearly-
 * labelled placeholder synchronously so the board card has something true to
 * show, then either replaces it with the real ERP order or **undoes the stage
 * move** if the ERP refuses. Leaving a card sitting in Order with no order
 * behind it is the exact class of lie this integration is correcting.
 *
 * Every capability below is behind a real endpoint. That was not true when this
 * file was written: the quote desk, cancellation and reschedule were all
 * "stated, not simulated" refusals against a `gable` that had no endpoint for
 * them. It now does, and each one is wired — with one distinction that must
 * survive into the UI and does:
 *
 *   **A reschedule is a REQUEST, not a write.** `POST /deliveries/{id}/
 *   reschedule` answers 202 with `applied: false` and never touches
 *   `delivery_routes`. The date on the dealer's board does not move. Every
 *   sentence this file writes about a reschedule says "requested" and none of
 *   them says "moved", because a contractor who believes a delivery moved when
 *   it has not is worse off than one who knows it is pending.
 *
 * What is still genuinely absent, and is refused rather than faked:
 *
 *   - **Quote -> order conversion.** `gable` has no endpoint that turns an
 *     accepted quote into an order; accepting closes the quote and the order
 *     still goes through cart + checkout. Accepting therefore does not place
 *     anything, and nothing here pretends it does.
 *   - **A unit of measure `gable` does not have.** Its `uom_type` enum has no
 *     cubic yard. A line measured in one is refused by name rather than
 *     relabelled into a unit the dealer would price differently.
 */

export interface GableSupplierDeps {
  client: GableClient;
  /** Sim time is the app's clock everywhere; the ERP path uses it too so
   *  timestamps on a board are comparable regardless of which side wrote them. */
  nowIso: () => IsoDateTime;
  /** The dealer's configured name, for contractor-facing sentences. */
  dealerName: string;
}

const GABLE_CAPABILITIES: SupplierCapabilities = {
  quoteDesk: true,
  quoteDecisions: true,
  cancellation: true,
  projectAssociation: true,
  // 202 + `applied: false`. Not a write, and the word matters — see the class
  // comment above.
  reschedule: 'requests',
  leadTimes: true,
  volumeBreaks: true,
  categoryTree: true,
  changeFeed: true,
};

/** Placeholder id while the ERP has not answered yet. Derived, so it is findable. */
export function pendingSalesOrderIdFor(orderId: string): string {
  return `gso_pending_${orderId}`;
}

/**
 * The portal's closed UOM union onto `gable`'s `uom_type` enum (migration 001).
 *
 * `null` means there is no honest translation. A cubic yard is the live case:
 * `gable` has no CY, and sending `EA` would put a line on a dealer's quote desk
 * measured in a unit nobody agreed to — which is how a contractor gets priced
 * for one of something that should have been eleven yards.
 */
const GABLE_UOM: Record<Uom, string | null> = {
  EA: 'EA',
  LF: 'LF',
  BF: 'BF',
  SQ: 'SQ',
  // A sheet of plywood is a piece at the counter; PCS is `gable`'s word for it.
  SHT: 'PCS',
  BD: 'BUNDLE',
  BG: 'BAG',
  BX: 'BOX',
  RL: 'RL',
  CY: null,
};

function log(entry: Omit<ActivityEntry, 'id' | 'at'>, at: IsoDateTime): void {
  const state = activityStore.get();
  activityStore.set({
    ...state,
    entries: [{ ...entry, id: newId('act'), at }, ...state.entries].slice(0, MAX_ACTIVITY_ENTRIES),
  });
}

/**
 * The order's lines in a STABLE order.
 *
 * Sorted by `sortOrder`, and that is load-bearing rather than cosmetic: a quote
 * is sent as an ordered list and `gable` returns its lines in insertion order,
 * so this sort is one half of the correlation that finds a scope item again
 * after the dealer has priced it. See `applyQuotePrices`.
 */
function itemsFor(orderId: string): ScopeItem[] {
  return listOf(scopeStore.get())
    .filter((item) => item.orderId === orderId)
    .sort((a, b) => a.sortOrder - b.sortOrder);
}

/** `gable`'s portal quote vocabulary onto the portal's own five-state flow. */
export function quoteStatusFrom(gableStatus: string): QuoteStatus {
  switch (gableStatus.trim().toUpperCase()) {
    case 'REQUESTED':
      return 'submitted';
    case 'PRICED':
      return 'priced';
    // The portal has no `accepted` state — a quote it accepted is one whose
    // prices stand, which is what `priced` already means here. The raw word is
    // kept on `supplierState` so nothing has to infer it back.
    case 'ACCEPTED':
      return 'priced';
    case 'DECLINED':
      return 'withdrawn';
    case 'EXPIRED':
      return 'expired';
    default:
      // An unrecognised state passes through as the most conservative thing
      // that is certainly true: it was sent, and nobody here should claim it
      // has a price.
      return 'submitted';
  }
}

/**
 * Build the local `Quote` record from what `gable` returned.
 *
 * `linePrices` is filled by `applyQuotePrices`, which is the only thing allowed
 * to correlate a dealer's line back onto a scope item — see there for why that
 * correlation refuses rather than guesses.
 */
function quoteRecordFrom(input: {
  localId: string;
  orderId: string;
  dto: GableQuote;
  dealerName: string;
  submittedAt: IsoDateTime;
  linePrices?: Quote['linePrices'];
}): Quote {
  const status = quoteStatusFrom(input.dto.status);
  return {
    id: input.localId,
    orderId: input.orderId,
    // `gable` publishes no human quote number on the portal surface, so this
    // is a short form of its id rather than a minted Q-1001 nobody at the
    // dealer could look up.
    number: `GQ-${input.dto.id.slice(0, 8)}`,
    status,
    supplierRef: input.dto.id,
    supplierState: input.dto.status,
    submittedAt: input.dto.created_at || input.submittedAt,
    ...(input.dto.sent_at ? { pricedAt: input.dto.sent_at } : {}),
    ...(input.dto.expires_at ? { expiresAt: input.dto.expires_at } : {}),
    deskNote: input.dto.priced
      ? `${input.dealerName} priced this quote. Their total is the one that stands.`
      : `Sent to ${input.dealerName}. They price it; nothing here is a price yet.`,
    linePrices: input.linePrices ?? [],
  };
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

  /**
   * Record an order `gable` accepted but would not describe.
   *
   * `POST /checkout` returned an id, so the order is real and the dealer can
   * see it; only the follow-up `GET /orders/{id}` failed. The card therefore
   * stays in Order and keeps a REAL sales-order id (`gso_<erp id>`, the same id
   * `salesOrderIdFor` mints), so the next status poll patches this card instead
   * of creating a second one — and so a contractor is never invited to place
   * the same order twice.
   *
   * What it does NOT do is guess. The status is `submitted`, which is the one
   * thing known to be true; the number is derived from the id the same way
   * `salesOrderFrom` derives it; and the subtotal is the portal's own line
   * total, clearly a local figure until the dealer's own numbers are read back.
   * The tracking note and the activity entry both say plainly that the order
   * was placed and its details could not be read.
   */
  function adoptUnreadOrder(
    order: Order,
    gableOrderId: string,
    items: readonly ScopeItem[],
    reason: string,
  ): void {
    const at = nowIso();
    const note = `Placed with ${dealerName}, but their system did not return the order details: ${reason} The order stands — this card will fill in on the next status check.`;

    salesOrdersStore.set(remove(salesOrdersStore.get(), pendingSalesOrderIdFor(order.id)));
    const salesOrder: SalesOrder = {
      id: salesOrderIdFor(gableOrderId),
      orderId: order.id,
      number: `GBL-${gableOrderId.slice(0, 8)}`,
      status: 'submitted',
      fulfillment: order.fulfillment,
      submittedAt: at,
      subtotal: items.reduce((sum, item) => sum + (item.unitPrice ?? 0) * item.qty, 0),
      tracking: [{ at, status: 'submitted', note }],
    };
    salesOrdersStore.set(upsert(salesOrdersStore.get(), salesOrder));
    ordersStore.set(patch(ordersStore.get(), order.id, { salesOrderId: salesOrder.id }));

    log({ actor: 'system', kind: 'order.submitted', message: note, orderId: order.id }, at);
    // `error`, not `connected`: the last call did fail and the connection sheet
    // should say so. The order is still on the board because it is still real.
    setGableState({ status: 'error', error: reason, lastSyncAt: at });
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
      /**
       * The job this order is for. On the wired path a board project IS an ERP
       * project — `connect.ts` adopts them from `GET /projects` — so the id is
       * one `gable` will recognise. It verifies ownership and REFUSES checkout
       * on a project that is not this customer's, so a stale id fails loudly
       * here rather than filing the order against someone else's job.
       */
      project_id: order.projectId,
    });

    /**
     * The order EXISTS from this line on.
     *
     * Everything above can fail and mean "the dealer did not take it": the
     * cart calls, the checkout itself. Everything below is a READ of an order
     * `gable` has already created and committed. Letting a failed read fall
     * through to the caller's `rollback` told a contractor their order was
     * refused while the yard was picking it, cleared the ERP id the status
     * poll needs to find the card again, and left the only recovery a
     * resubmit — which places the order a SECOND time. A read failure is not a
     * refusal, so it is caught here rather than thrown to a handler that can
     * only conclude one thing.
     */
    let placed: Awaited<ReturnType<GableClient['order']>>;
    try {
      placed = await client.order(checkout.order_id);
    } catch (error) {
      adoptUnreadOrder(order, checkout.order_id, items, describeRefusal(error));
      return;
    }
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

  /**
   * Turn the order's scope into a quote request.
   *
   * Returns the refusal sentence instead of lines when a line cannot be
   * expressed — today only an untranslatable unit of measure. Refusing before
   * the request is sent is the same rule `createOrderWithSupplier` follows for
   * a special-order line on a cart: half a package on a dealer's desk is worse
   * than none.
   */
  function quoteLinesFor(items: readonly ScopeItem[]): Result<GableQuoteRequestLine[]> {
    const lines: GableQuoteRequestLine[] = [];
    for (const item of items) {
      const uom = GABLE_UOM[item.uom];
      if (!uom) {
        return err(
          `${dealerName}'s system has no unit for ${item.uom}, so "${item.snapshot.name}" cannot be sent for pricing. Call your rep for this line.`,
        );
      }

      lines.push({
        // Null product id is the special-order case, and `gable` supports it
        // directly: a line described in words, with a quantity and a unit,
        // priced by a human. This is the whole reason the quote desk exists and
        // the reason a special line can now leave this browser at all.
        ...(item.productId ? { product_id: item.productId } : {}),
        description: item.snapshot.name,
        quantity: item.qty,
        uom,
        note: item.notes ?? '',
      });
    }
    return ok(lines);
  }

  /** The local quote record for a board order, if it has one. */
  function localQuoteFor(orderId: string): Quote | undefined {
    const order = ordersStore.get().byId[orderId];
    if (!order?.quoteId) return undefined;
    return quotesStore.get().byId[order.quoteId];
  }

  /**
   * The delivery `gable` has for a board order, if any.
   *
   * Resolved through the order's ERP id rather than held on the board, because
   * a delivery is created by the dealer's dispatch board and the portal only
   * ever learns about it by asking.
   */
  async function deliveryIdFor(orderId: string): Promise<Result<string>> {
    const order = ordersStore.get().byId[orderId];
    const salesOrder = order?.salesOrderId
      ? salesOrdersStore.get().byId[order.salesOrderId]
      : undefined;
    if (
      !salesOrder ||
      !salesOrder.id.startsWith('gso_') ||
      salesOrder.id.startsWith('gso_pending_')
    ) {
      return err(`This order is not with ${dealerName} yet.`);
    }

    const gableOrderId = salesOrder.id.slice('gso_'.length);
    const deliveries = await client.deliveries();
    const match = deliveries.find((delivery) => delivery.order_id === gableOrderId);
    if (!match) {
      return err(
        `${dealerName} has not scheduled a delivery for ${salesOrder.number} yet, so there is no date to move. They will schedule it and you can ask then.`,
      );
    }
    return ok(match.id);
  }

  return {
    kind: 'gable',
    capabilities: GABLE_CAPABILITIES,

    /**
     * Send the scope to the dealer's quote desk, for real.
     *
     * An optimistic local record is written first so `domain/stage.ts` keeps its
     * invariant — an order in Quote must have a `quoteId` — and it is REPLACED
     * by the dealer's own quote once `gable` answers. If the request is refused
     * the card goes back to Plan and the local record is removed: a card in
     * Quote whose scope nobody received is the same lie as a card in Order with
     * no order behind it.
     */
    submitToQuoteDesk(orderId) {
      const at = nowIso();
      const items = itemsFor(orderId);
      if (items.length === 0) {
        rollback(orderId, 'plan', 'there is nothing on this order to price.');
        return;
      }

      const lines = quoteLinesFor(items);
      if (!lines.ok) {
        rollback(orderId, 'plan', lines.error);
        return;
      }

      const localId = newId('q');
      const pending: Quote = {
        id: localId,
        orderId,
        number: 'Sending…',
        status: 'submitted',
        submittedAt: at,
        // Deliberately no expiry while it is in flight: an expiry implies a
        // price is being held, and nobody at the dealer has seen this yet.
        linePrices: [],
        deskNote: `Sending this scope to ${dealerName} for pricing…`,
      };
      quotesStore.set(upsert(quotesStore.get(), pending));
      ordersStore.set(patch(ordersStore.get(), orderId, { quoteId: localId }));

      void client
        .createQuote({
          project_id: ordersStore.get().byId[orderId]?.projectId,
          notes: ordersStore.get().byId[orderId]?.name ?? '',
          delivery_type:
            ordersStore.get().byId[orderId]?.fulfillment === 'willcall' ? 'PICKUP' : 'DELIVERY',
          lines: lines.value,
        })
        .then((dto) => {
          const observedAt = nowIso();
          quotesStore.set(
            upsert(
              quotesStore.get(),
              quoteRecordFrom({ localId, orderId, dto, dealerName, submittedAt: at }),
            ),
          );
          log(
            {
              actor: 'system',
              kind: 'quote.submitted',
              message: `Sent this scope to ${dealerName}'s quote desk. It is on their board as GQ-${dto.id.slice(0, 8)} and waiting to be priced — nothing here is a price yet.`,
              orderId,
            },
            observedAt,
          );
          setGableState({ status: 'connected', error: null, lastSyncAt: observedAt });
        })
        .catch((error: unknown) => {
          quotesStore.set(remove(quotesStore.get(), localId));
          const order = ordersStore.get().byId[orderId];
          if (order) {
            const { quoteId: _dropped, ...withoutQuote } = order;
            ordersStore.set(upsert(ordersStore.get(), withoutQuote));
          }
          rollback(orderId, 'plan', describeRefusal(error));
        });
    },

    /**
     * Pull the scope back off the dealer's desk.
     *
     * `gable` only lets a customer decline a quote it has PRICED and SENT — an
     * unpriced request is not decidable and comes back 409 `QUOTE_NOT_PRICED`.
     * That refusal is reported truthfully: the local record is NOT marked
     * withdrawn, because the dealer still has the request and marking it would
     * tell the contractor their scope had been pulled when a salesperson is
     * still looking at it.
     */
    withdrawFromQuoteDesk(orderId) {
      const at = nowIso();
      const quote = localQuoteFor(orderId);
      if (!quote) return;

      if (!quote.supplierRef) {
        // Never reached the dealer — nothing to withdraw from.
        quotesStore.set(patch(quotesStore.get(), quote.id, { status: 'withdrawn' }));
        return;
      }

      void client
        .declineQuote(quote.supplierRef)
        .then((dto) => {
          quotesStore.set(
            patch(quotesStore.get(), quote.id, {
              status: quoteStatusFrom(dto.status),
              supplierState: dto.status,
            }),
          );
          log(
            {
              actor: 'user',
              kind: 'quote.withdrawn',
              message: `Declined ${quote.number}. ${dealerName} has it as ${dto.status}.`,
              orderId,
            },
            nowIso(),
          );
        })
        .catch((error: unknown) => {
          log(
            {
              actor: 'system',
              kind: 'quote.withdraw-refused',
              message:
                refusalCodeOf(error) === 'QUOTE_NOT_PRICED'
                  ? `${dealerName} still has ${quote.number} on their desk — a request they have not priced yet cannot be withdrawn from the portal. Call your rep if you need it pulled.`
                  : `Could not withdraw ${quote.number} from ${dealerName}: ${describeRefusal(error)}`,
              orderId,
            },
            at,
          );
        });
    },

    createOrderWithSupplier(order, from) {
      const items = itemsFor(order.id);
      const at = nowIso();

      /**
       * A special-order line has no ERP product id — that is what "special"
       * means. `gable`'s cart takes a `product_id` and nothing else, so there
       * is no way to put one on a real order. Refuse before touching the ERP
       * rather than half-submitting a package that is missing its custom door.
       *
       * The quote desk is the route for those, and it is now a real one:
       * `POST /quotes` takes a line with no product id, so a special-order item
       * can reach the dealer, be priced by a human, and come back — which is
       * what makes this refusal a redirection rather than a dead end.
       */
      const special = items.filter((item) => item.kind !== 'catalog' || !item.productId);
      if (special.length > 0) {
        rollback(
          order.id,
          from,
          `${special.length} special-order line${special.length === 1 ? '' : 's'} cannot be sent — the ERP order API takes catalog products only. Send this to the quote desk instead.`,
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
        rollback(order.id, from, describeRefusal(error));
      });
    },

    /**
     * Cancel the order in the dealer's ERP, for real.
     *
     * Three refusals come back as 409 and each means something different to a
     * contractor, so each gets the dealer's own sentence rather than a generic
     * one: `ORDER_ALREADY_CANCELLED`, `ORDER_NOT_CANCELLABLE` (it is fulfilled
     * — ask for a credit), and `ORDER_IN_MOTION` (the goods are on a dispatched
     * route).
     *
     * On a refusal the card goes BACK to where it came from. The stage machine
     * already moved it to Plan when this ran, and leaving it there would show a
     * contractor an order they believe they killed and the dealer is still
     * picking.
     */
    cancelWithSupplier(orderId, from) {
      const at = nowIso();
      const order = ordersStore.get().byId[orderId];
      const salesOrder = order?.salesOrderId
        ? salesOrdersStore.get().byId[order.salesOrderId]
        : undefined;

      if (!salesOrder || !salesOrder.id.startsWith('gso_')) {
        // Never reached the ERP. Nothing to cancel and nothing to say.
        return;
      }
      if (salesOrder.id.startsWith('gso_pending_')) {
        log(
          {
            actor: 'system',
            kind: 'order.cancel-refused',
            message: `This order is still on its way to ${dealerName} and has no id there yet. Wait for it to land, then cancel.`,
            orderId,
          },
          at,
        );
        return;
      }

      const gableOrderId = salesOrder.id.slice('gso_'.length);

      void client
        .cancelOrder(gableOrderId, 'Cancelled by the contractor from the portal')
        .then((response) => {
          const observedAt = nowIso();
          salesOrdersStore.set(
            patch(salesOrdersStore.get(), salesOrder.id, {
              status: 'cancelled',
              tracking: [
                ...salesOrder.tracking,
                {
                  at: observedAt,
                  status: 'cancelled' as const,
                  note: `${dealerName} cancelled this order. It was ${response.previous_status}.`,
                },
              ],
            }),
          );
          log(
            {
              actor: 'user',
              kind: 'order.cancelled',
              message: `Cancelled ${salesOrder.number} with ${dealerName}.`,
              orderId,
            },
            observedAt,
          );
          setGableState({ status: 'connected', error: null, lastSyncAt: observedAt });
        })
        .catch((error: unknown) => {
          const observedAt = nowIso();
          const reason = describeRefusal(error);

          // Status UNCHANGED. The dealer said no, so the order still stands and
          // showing `cancelled` would assert something about the ERP that is
          // not true.
          salesOrdersStore.set(
            patch(salesOrdersStore.get(), salesOrder.id, {
              tracking: [
                ...salesOrder.tracking,
                { at: observedAt, status: salesOrder.status, note: reason },
              ],
            }),
          );

          const current = ordersStore.get().byId[orderId];
          if (current) {
            ordersStore.set(
              patch(ordersStore.get(), orderId, { stage: from, updatedAt: observedAt }),
            );
          }

          log(
            {
              actor: 'system',
              kind: 'order.cancel-refused',
              message: `${dealerName} would not cancel ${salesOrder.number}: ${reason}`,
              orderId,
            },
            observedAt,
          );
        });
    },

    async requestReschedule(orderId, date): Promise<Result<RescheduleOutcome>> {
      const deliveryId = await deliveryIdFor(orderId);
      if (!deliveryId.ok) return deliveryId;

      try {
        const dto = await client.requestReschedule(deliveryId.value, {
          // A calendar day, not an instant. `gable` accepts YYYY-MM-DD
          // deliberately: a dealer can commit to a day and nothing in the
          // system can commit to an hour.
          requested_date: date.slice(0, 10),
          reason: 'Requested from the contractor portal',
        });

        const order = ordersStore.get().byId[orderId];
        const salesOrder = order?.salesOrderId
          ? salesOrdersStore.get().byId[order.salesOrderId]
          : undefined;
        const at = nowIso();

        /**
         * The board's `promisedDate` is NOT touched. It is what the dealer has
         * committed to, and the dealer has committed to nothing new. The ask is
         * recorded on the tracking log, where it reads as an ask.
         */
        if (salesOrder) {
          salesOrdersStore.set(
            patch(salesOrdersStore.get(), salesOrder.id, {
              tracking: [
                ...salesOrder.tracking,
                {
                  at,
                  status: salesOrder.status,
                  note: `Asked ${dealerName} to move this to ${dto.requested_date}. Their board still says ${dto.current_scheduled_date ?? 'no date yet'} — a dispatcher has to agree before anything moves.`,
                },
              ],
            }),
          );
        }

        log(
          {
            actor: 'user',
            kind: 'order.reschedule-requested',
            message: `Requested ${dto.requested_date} for ${salesOrder?.number ?? 'this order'}. ${dealerName} has not confirmed it.`,
            orderId,
          },
          at,
        );

        return ok({
          // Straight from the ERP. It is false for everything the portal can
          // file, and this is not the place to decide otherwise.
          applied: dto.applied,
          requestedDate: dto.requested_date,
          ...(dto.current_scheduled_date
            ? { currentScheduledDate: dto.current_scheduled_date }
            : {}),
          status: dto.status,
          message: dto.applied
            ? `${dealerName} moved this to ${dto.requested_date}.`
            : `Requested — ${dealerName} has your ask for ${dto.requested_date}. Nothing has moved until a dispatcher agrees.`,
        });
      } catch (error) {
        return err(describeRefusal(error));
      }
    },

    async decideQuote(orderId, decision: QuoteDecision): Promise<Result<Quote>> {
      const quote = localQuoteFor(orderId);
      if (!quote) return err('There is no quote on this order.');
      if (!quote.supplierRef) {
        return err(`This quote was never sent to ${dealerName}, so there is nothing to answer.`);
      }

      try {
        const dto =
          decision === 'accept'
            ? await client.acceptQuote(quote.supplierRef)
            : await client.declineQuote(quote.supplierRef);

        const expiresAt = dto.expires_at ?? undefined;
        const applied = decision === 'accept' ? applyQuotePricesFor(orderId, dto, expiresAt) : null;

        const updated = quoteRecordFrom({
          localId: quote.id,
          orderId,
          dto,
          dealerName,
          submittedAt: quote.submittedAt,
          ...(applied ? { linePrices: applied } : { linePrices: quote.linePrices }),
        });
        quotesStore.set(upsert(quotesStore.get(), updated));

        log(
          {
            actor: 'user',
            kind: decision === 'accept' ? 'quote.accepted' : 'quote.declined',
            message:
              decision === 'accept'
                ? `Accepted ${updated.number}. ${dealerName} has it as ${dto.status}. Place the order when you are ready — accepting a quote does not place one.`
                : `Declined ${updated.number}. ${dealerName} has it as ${dto.status}.`,
            orderId,
          },
          nowIso(),
        );
        return ok(updated);
      } catch (error) {
        return err(describeRefusal(error));
      }
    },

    async attachOrderToProject(supplierOrderId, projectId): Promise<Result<void>> {
      try {
        await client.setOrderProject(supplierOrderId, projectId);
        return ok(undefined);
      } catch (error) {
        return err(describeRefusal(error));
      }
    },
  };
}

/**
 * Kept next to the supplier because it is the same contract read backwards:
 * the ERP is the source of order state, so the portal asks rather than ages.
 *
 * Returns the number of board orders whose supplier record changed, so a caller
 * can decide whether the refresh was worth announcing.
 *
 * ## The poll is CONDITIONAL now
 *
 * `cursor` and `etag` are the two primitives `gable` publishes for exactly this
 * (`X-Portal-Latest-Change` and `ETag`), and both are used:
 *
 *  - `If-None-Match` turns an unchanged list into a 304 with no body. The whole
 *    call short-circuits and `deliveries` is not fetched either — a 30-second
 *    poll that transferred a full order list and a full delivery list to
 *    discover nothing had happened was two round trips of pure waste.
 *  - `?since=` narrows a changed list to what actually moved. It compares
 *    `updated_at`, not `created_at`, which is what makes a CONFIRMED -> ON_HOLD
 *    transition visible at all — the portal rounds both to `confirmed`, so a
 *    created_at cursor would have shown nothing.
 *
 * The cursor is only advanced when a page genuinely came back. Advancing it on
 * a 304 would be advancing past a timestamp the ERP never sent.
 */
export interface SyncOrderStatusInput extends GableSupplierDeps {
  /** `X-Portal-Latest-Change` from the previous read, if there was one. */
  cursor?: string | undefined;
  /** `ETag` from the previous read, if there was one. */
  etag?: string | undefined;
}

export interface SyncOrderStatusResult {
  /** Board orders whose supplier record changed. */
  changed: number;
  /** True when the ERP answered 304 and no work was done at all. */
  notModified: boolean;
  cursor: string | undefined;
  etag: string | undefined;
}

export async function syncOrderStatus(deps: SyncOrderStatusInput): Promise<SyncOrderStatusResult> {
  const { client, nowIso } = deps;
  const at = nowIso();

  const feed = await client.orderFeed({
    since: deps.cursor,
    ifNoneMatch: deps.etag,
  });

  if (feed.orders === null) {
    // Nothing this customer can see has moved. No deliveries call, no store
    // writes, no activity entry — a poll that found nothing should cost
    // nothing and should say nothing.
    setGableState({ lastSyncAt: at, syncing: false });
    return { changed: 0, notModified: true, cursor: deps.cursor, etag: feed.etag ?? deps.etag };
  }

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

  const relevant = feed.orders.filter((dto) => boardByGableId.has(dto.id));
  // Deliveries are only worth fetching when something on this board moved.
  const deliveries = relevant.length > 0 ? await client.deliveries() : [];
  const deliveryByOrder = new Map(deliveries.map((delivery) => [delivery.order_id, delivery]));

  let changed = 0;
  for (const dto of relevant) {
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
  return {
    changed,
    notModified: false,
    cursor: feed.latestChange ?? deps.cursor,
    etag: feed.etag ?? deps.etag,
  };
}

/**
 * Read the dealer's pricing back onto the board.
 *
 * The counterpart of `submitToQuoteDesk`: a contractor sends a scope, a person
 * at the dealer prices it, and this is how the portal finds out. Without it the
 * quote column would be a one-way outbox.
 *
 * Only quotes this portal SENT are looked at — a quote with no `supplierRef`
 * never left the browser, and a dealer quote with no board card is theirs, not
 * this board's.
 */
export async function syncQuotes(deps: GableSupplierDeps): Promise<number> {
  const { client, nowIso, dealerName } = deps;

  const local = listOf(quotesStore.get()).filter((quote) => quote.supplierRef !== undefined);
  if (local.length === 0) return 0;

  const remote = await client.quotes();
  const byId = new Map(remote.map((dto) => [dto.id, dto]));

  let changed = 0;
  for (const quote of local) {
    const dto = quote.supplierRef ? byId.get(quote.supplierRef) : undefined;
    if (!dto) continue;
    // De-duplicate on the ERP's own word, for the same reason the order feed
    // does: two different dealer states can round to one portal status.
    if (dto.status === quote.supplierState) continue;

    const expiresAt = dto.expires_at ?? undefined;
    const applied = dto.priced ? applyQuotePricesFor(quote.orderId, dto, expiresAt) : null;

    quotesStore.set(
      upsert(quotesStore.get(), {
        ...quote,
        status: quoteStatusFrom(dto.status),
        supplierState: dto.status,
        ...(dto.sent_at ? { pricedAt: dto.sent_at } : {}),
        ...(expiresAt ? { expiresAt } : {}),
        deskNote: dto.priced
          ? `${dealerName} priced this quote. Their total is the one that stands.`
          : `With ${dealerName}. They price it; nothing here is a price yet.`,
        ...(applied ? { linePrices: applied } : {}),
      }),
    );

    const at = nowIso();
    activityStore.set({
      ...activityStore.get(),
      entries: [
        {
          id: newId('act'),
          at,
          actor: 'system' as const,
          kind: 'quote.priced',
          message: dto.priced
            ? applied
              ? `${dealerName} priced ${quote.number} — their numbers are on your lines.`
              : `${dealerName} priced ${quote.number}, but its lines no longer match this order's scope, so no price was applied. Open the quote with your rep.`
            : `${dealerName} moved ${quote.number} to ${dto.status}.`,
          orderId: quote.orderId,
        },
        ...activityStore.get().entries,
      ].slice(0, MAX_ACTIVITY_ENTRIES),
    });
    changed += 1;
  }

  return changed;
}

/**
 * Standalone twin of the closure inside `createGableSupplier`, for the poll
 * path — which has no supplier instance to reach into. Same rule and the same
 * refusal: verified positional correlation, or nothing is written.
 */
function applyQuotePricesFor(
  orderId: string,
  dto: GableQuote,
  expiresAt: IsoDateTime | undefined,
): Quote['linePrices'] | null {
  const items = itemsFor(orderId);
  const lines = dto.lines ?? [];
  if (lines.length === 0 || lines.length !== items.length) return null;

  const linePrices: Quote['linePrices'] = [];
  for (const [index, item] of items.entries()) {
    const line = lines[index];
    if (!line) return null;
    const agrees = item.productId
      ? line.product_id === item.productId
      : line.product_id === null && line.description === item.snapshot.name;
    if (!agrees) return null;
    linePrices.push({ scopeItemId: item.id, unitPrice: toCents(line.unit_price), leadTimeDays: 0 });
  }

  for (const line of linePrices) {
    scopeStore.set(
      patch(scopeStore.get(), line.scopeItemId, {
        unitPrice: line.unitPrice,
        priceSource: 'quoted',
        ...(expiresAt ? { priceExpiresAt: expiresAt } : {}),
      }),
    );
  }
  return linePrices;
}
