// SPDX-License-Identifier: LicenseRef-OpenLBM-Community-Source-1.0
// SPDX-FileCopyrightText: 2026 FutureBuild, Inc. and OpenLBM contributors
import { supplierName } from '../config/runtime';
import { type Result, err, ok } from '../lib/result';
import { type IsoDateTime, formatDate, startOfDay } from '../lib/time';
import {
  type Order,
  type OrderStage,
  type ScopeItem,
  isPriceExpired,
  isPriced,
  needsQuoteDesk,
} from './project';
import type { SalesOrderStatus } from './supplier';

/**
 * The rules that decide whether a card may move between board columns.
 *
 * Two product principles drive every rule here:
 *
 * 1. The contractor is in control. Dragging a card does something real; the
 *    system only blocks a move when it genuinely cannot be honoured, and when
 *    it blocks it says why in words the contractor would use. Every rejection
 *    string here is shown verbatim in the UI and handed verbatim to the AI.
 *
 * 2. The quote desk is a gate, not a toll booth. An order that is fully priced
 *    by the ERP may go straight Plan -> Order: that is the whole promise of
 *    account pricing, and forcing everyone through a sales desk would recreate
 *    the friction this product exists to remove. But an order containing a
 *    special-order line has no real price, so it MUST be quoted first --
 *    otherwise the contractor is committing to a number nobody has stood behind.
 */

export interface StageContext {
  items: readonly ScopeItem[];
  /**
   * Sim time. Required because a quoted price can lapse: the same order that
   * was placeable yesterday may not be today, and the guard has to know.
   */
  now: IsoDateTime;
  /**
   * The supplier's live status when a sales order exists. Required for the
   * pull-back guard: an order whose truck is already rolling — or whose goods
   * are already on site awaiting a bill — cannot be cancelled by a drag.
   */
  supplierStatus?: SalesOrderStatus | undefined;
}

/** Once the goods have left the yard, cancellation is a phone call, not a drag. */
const PAST_CANCEL: readonly SalesOrderStatus[] = ['out-for-delivery', 'delivered', 'invoiced'];

/** Side effects the action layer must perform after an allowed transition. */
export type StageEffect =
  | { kind: 'submit-to-quote-desk' }
  | { kind: 'withdraw-from-quote-desk' }
  | { kind: 'create-sales-order' }
  | { kind: 'cancel-sales-order' };

export interface StageMove {
  from: OrderStage;
  to: OrderStage;
  effects: StageEffect[];
}

const STAGE_INDEX: Record<OrderStage, number> = {
  plan: 0,
  quote: 1,
  order: 2,
  invoice: 3,
};

function pluralItems(n: number): string {
  return n === 1 ? '1 item' : `${n} items`;
}

/** Subject-verb agreement, because these sentences are shown to a human. */
function verb(n: number, singular: string, plural: string): string {
  return n === 1 ? singular : plural;
}

/**
 * Can this order move to `to`? Returns the effects to run, or a
 * contractor-readable reason it cannot.
 */
export function canMoveToStage(order: Order, to: OrderStage, ctx: StageContext): Result<StageMove> {
  const from = order.stage;
  if (from === to) return err(`Already in ${to}.`);

  const items = ctx.items;
  const forward = STAGE_INDEX[to] > STAGE_INDEX[from];

  // --- Forward moves -------------------------------------------------------

  if (forward && items.length === 0) {
    return err('This order is empty — add materials before moving it forward.');
  }

  if (to === 'quote') {
    if (from !== 'plan') {
      return err('An order can only be sent to the quote desk from Plan.');
    }
    return ok({ from, to, effects: [{ kind: 'submit-to-quote-desk' }] });
  }

  if (to === 'order') {
    if (from === 'invoice') {
      return err('This order has already been invoiced.');
    }

    const unquoted = needsQuoteDesk(items, ctx.now);
    if (unquoted.length > 0) {
      const names = unquoted
        .slice(0, 2)
        .map((item) => item.snapshot.name)
        .join(', ');
      const more = unquoted.length > 2 ? ` and ${unquoted.length - 2} more` : '';

      // Distinguish "never priced" from "the dealer's price ran out", because
      // they feel completely different to a contractor.
      const allExpired = unquoted.every((item) => isPriceExpired(item, ctx.now));
      if (allExpired) {
        return err(
          `${supplierName()}'s pricing on ${pluralItems(unquoted.length)} has expired (${names}${more}). Send this order back to the quote desk for a fresh price.`,
        );
      }

      return err(
        `${pluralItems(unquoted.length)} ${verb(unquoted.length, 'needs', 'need')} dealer pricing first (${names}${more}). Send this order to the quote desk.`,
      );
    }

    const unpriced = items.filter((item) => !isPriced(item, ctx.now));
    if (unpriced.length > 0) {
      return err(
        `${pluralItems(unpriced.length)} still ${verb(unpriced.length, 'has', 'have')} no price.`,
      );
    }

    if (!order.requestedDate) {
      return err('Set a delivery or pickup date before submitting this order.');
    }
    if (startOfDay(order.requestedDate) < startOfDay(ctx.now)) {
      return err(
        `The requested date (${formatDate(order.requestedDate)}) has already passed — pick a new ${
          order.fulfillment === 'willcall' ? 'pickup' : 'delivery'
        } date before submitting.`,
      );
    }
    if (order.fulfillment === 'delivery' && !order.deliveryAddressId) {
      return err('Add a delivery address before submitting this order.');
    }

    const effects: StageEffect[] = [{ kind: 'create-sales-order' }];
    if (from === 'quote') effects.unshift({ kind: 'withdraw-from-quote-desk' });
    return ok({ from, to, effects });
  }

  if (to === 'invoice') {
    // Invoicing is the supplier's move, not the contractor's. The sim advances
    // a card here once the order is delivered and billed; a contractor dragging
    // it would be claiming a bill that does not exist.
    return err('Orders move to Invoice once the supplier delivers and bills them.');
  }

  // --- Backward moves ------------------------------------------------------

  if (to === 'plan') {
    if (from === 'quote') {
      return ok({ from, to, effects: [{ kind: 'withdraw-from-quote-desk' }] });
    }
    if (from === 'order') {
      // Cancellation is only real while the goods are still in the yard. Once
      // the truck rolls — or the load is already on site waiting for its bill —
      // a drag cannot un-ring that bell, and pretending it can would erase an
      // invoice for materials the contractor actually has.
      if (ctx.supplierStatus && PAST_CANCEL.includes(ctx.supplierStatus)) {
        return err(
          ctx.supplierStatus === 'out-for-delivery'
            ? "This order is already on the truck and can't be cancelled from here. Call your rep to turn it around."
            : 'This order has already been delivered — it can be paid, but not cancelled.',
        );
      }
      return ok({ from, to, effects: [{ kind: 'cancel-sales-order' }] });
    }
    return err('An invoiced order cannot go back to Plan.');
  }

  return err(`Cannot move from ${from} to ${to}.`);
}

/**
 * Stage the supplier moves a card to, not the contractor. Kept separate from
 * canMoveToStage so a user-driven drag can never reach it.
 */
export function systemAdvanceToInvoice(order: Order): Result<StageMove> {
  if (order.stage !== 'order') {
    return err('Only an order in the Order stage can be invoiced.');
  }
  return ok({ from: 'order', to: 'invoice', effects: [] });
}

/** Stages this order could legally move to right now — drives which drop targets light up. */
export function allowedTargets(order: Order, ctx: StageContext): OrderStage[] {
  const targets: OrderStage[] = [];
  for (const stage of ['plan', 'quote', 'order', 'invoice'] as OrderStage[]) {
    if (stage === order.stage) continue;
    if (canMoveToStage(order, stage, ctx).ok) targets.push(stage);
  }
  return targets;
}
