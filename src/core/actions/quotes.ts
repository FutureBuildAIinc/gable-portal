// SPDX-License-Identifier: LicenseRef-OpenLBM-Community-Source-1.0
// SPDX-FileCopyrightText: 2026 FutureBuild, Inc. and OpenLBM contributors
import { getContext } from '../boot';
import { supplierName } from '../config/runtime';
import type { Quote } from '../domain/supplier';
import { type Result, err, ok } from '../lib/result';
import { ordersStore, quotesStore } from '../stores/root';
import { requireCapability } from './team';

/**
 * Answering the dealer's quote.
 *
 * This exists only because `gable` grew a quote lifecycle a customer can act
 * on: `POST /quotes/{id}/accept` and `/decline`, both refused with a 409
 * `QUOTE_NOT_PRICED` unless the dealer has actually priced and sent the quote.
 * The simulator has no equivalent step and says so through
 * `capabilities.quoteDecisions` rather than pretending — see `supplier/sim.ts`.
 *
 * Two things these functions deliberately do NOT do:
 *
 *  - **Accepting does not place an order.** `gable` has no quote-to-order
 *    conversion on its portal surface; accepting closes the quote and the
 *    order still goes through cart + checkout. The board's Order column is
 *    still reached by moving the card, and the copy says so.
 *  - **They do not decide whether a quote is decidable.** The dealer's ERP owns
 *    that, and it owns it more precisely than this side can: "not priced yet"
 *    and "already closed" are the same refusal from here and different
 *    situations there. The refusal is passed through with `gable`'s own reason.
 */

/** True when the installed supplier can be asked at all. */
export function canDecideQuotes(): boolean {
  return getContext().supplier.capabilities.quoteDecisions;
}

function decidableQuote(orderId: string): Result<Quote> {
  const order = ordersStore.get().byId[orderId];
  if (!order) return err('That order no longer exists.');
  if (!order.quoteId) return err('This order has not been sent for pricing.');

  const quote = quotesStore.get().byId[order.quoteId];
  if (!quote) return err('This order has not been sent for pricing.');
  if (!quote.supplierRef) {
    return err(
      `This quote was never sent to ${supplierName()} — there is nothing for them to answer.`,
    );
  }
  return ok(quote);
}

async function decide(orderId: string, decision: 'accept' | 'decline'): Promise<Result<Quote>> {
  // Accepting a dealer's price is a commitment of the account's money, so it
  // sits behind the same gate as editing scope rather than behind none — the
  // pattern every other mutation in `actions/` follows.
  const gate = requireCapability('edit-scope');
  if (!gate.ok) return gate;

  const { supplier } = getContext();
  if (!supplier.capabilities.quoteDecisions) {
    // Not a generic refusal: the implementation's own sentence explains why
    // there is no such step for THIS supplier.
    return supplier.decideQuote(orderId, decision);
  }

  const resolved = decidableQuote(orderId);
  if (!resolved.ok) return resolved;

  return supplier.decideQuote(orderId, decision);
}

/**
 * Accept the dealer's priced quote.
 *
 * On success the dealer's line prices are written onto the scope, so the order
 * becomes placeable — that write is the supplier implementation's, and it
 * refuses rather than guessing if the dealer's lines no longer match this
 * order's scope.
 */
export function acceptSupplierQuote(orderId: string): Promise<Result<Quote>> {
  return decide(orderId, 'accept');
}

/** Decline it. The dealer's quote closes; nothing is written onto the scope. */
export function declineSupplierQuote(orderId: string): Promise<Result<Quote>> {
  return decide(orderId, 'decline');
}
