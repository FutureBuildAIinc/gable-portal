// SPDX-License-Identifier: LicenseRef-OpenLBM-Community-Source-1.0
// SPDX-FileCopyrightText: 2026 FutureBuild, Inc. and OpenLBM contributors
import type { Cents } from '../lib/money';
import type { IsoDateTime } from '../lib/time';
import { type ScopeItem, isPriced, itemExtended, needsQuoteDesk } from './project';

/**
 * Order and project money math. Pure functions, one definition each — the
 * board card, the order detail, the customer quote, and the AI all read the
 * same numbers, so a total can never disagree with itself between surfaces.
 */

export interface OrderTotals {
  /** What the contractor pays the supplier for priced lines. */
  subtotal: Cents;
  /** What those lines would cost at list — the saving story. */
  listSubtotal: Cents;
  savings: Cents;
  itemCount: number;
  /** Lines with no price yet. A total with these outstanding is incomplete. */
  unpricedCount: number;
  /** Lines that can only be priced by the dealer's quote desk. */
  awaitingQuoteCount: number;
}

export function orderTotals(items: readonly ScopeItem[], now?: IsoDateTime): OrderTotals {
  let subtotal = 0;
  let listSubtotal = 0;
  let unpricedCount = 0;

  for (const item of items) {
    if (isPriced(item, now)) {
      subtotal += itemExtended(item);
      listSubtotal += Math.round((item.listPrice ?? item.unitPrice ?? 0) * item.qty);
    } else {
      unpricedCount++;
    }
  }

  return {
    subtotal,
    listSubtotal,
    savings: Math.max(0, listSubtotal - subtotal),
    itemCount: items.length,
    unpricedCount,
    awaitingQuoteCount: needsQuoteDesk(items, now).length,
  };
}

/** True when every line carries a price the contractor could actually commit to. */
export function isFullyPriced(totals: OrderTotals): boolean {
  return totals.itemCount > 0 && totals.unpricedCount === 0;
}

/**
 * Is `subtotal` a number worth showing at all?
 *
 * `subtotal` sums only the PRICED lines, so an order whose lines are all
 * awaiting the quote desk sums to zero — and the order page rendered that as a
 * confident "$0.00" directly above "1 item still needs dealer pricing". The
 * order is not worth nothing; its worth is not yet known, and those are
 * different claims. Show "—" instead.
 *
 * A partly-priced order keeps its subtotal: that number is real, and the
 * "not included above" line already says what it excludes.
 *
 * Lives here rather than in a component because the board card and the order
 * page both make this call, and the two must never disagree.
 */
export function hasKnownSubtotal(totals: OrderTotals): boolean {
  return totals.itemCount > 0 && totals.unpricedCount < totals.itemCount;
}

export function sumOrderTotals(all: readonly OrderTotals[]): OrderTotals {
  return all.reduce<OrderTotals>(
    (acc, totals) => ({
      subtotal: acc.subtotal + totals.subtotal,
      listSubtotal: acc.listSubtotal + totals.listSubtotal,
      savings: acc.savings + totals.savings,
      itemCount: acc.itemCount + totals.itemCount,
      unpricedCount: acc.unpricedCount + totals.unpricedCount,
      awaitingQuoteCount: acc.awaitingQuoteCount + totals.awaitingQuoteCount,
    }),
    {
      subtotal: 0,
      listSubtotal: 0,
      savings: 0,
      itemCount: 0,
      unpricedCount: 0,
      awaitingQuoteCount: 0,
    },
  );
}
