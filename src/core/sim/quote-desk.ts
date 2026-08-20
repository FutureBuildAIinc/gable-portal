// SPDX-License-Identifier: LicenseRef-OpenLBM-Community-Source-1.0
// SPDX-FileCopyrightText: 2026 FutureBuild, Inc. and OpenLBM contributors
import { supplierName } from '../config/runtime';
import { isPriceExpired } from '../domain/project';
import type { Quote } from '../domain/supplier';
import { newId } from '../lib/ids';
import type { Cents } from '../lib/money';
import { rngFor } from '../lib/rng';
import { addDays, fromIso } from '../lib/time';
import { SIM } from './config';
import type { SimContext } from './types';

/**
 * Gable Supply's quote desk.
 *
 * Two things it has to get right to be believable: it takes hours rather than
 * milliseconds (an instant answer reads as a machine, and the whole premise is
 * that a person priced it), and it puts a real number on the special-order
 * lines the ERP couldn't touch — which is the entire reason an order was routed
 * here in the first place.
 */

/** A plausible price for something not in the catalog, derived from its description. */
function priceSpecialItem(seed: number, itemId: string, description: string): Cents {
  const rng = rngFor(seed, `special:${itemId}`);

  // Anchor on what the thing sounds like, so a door isn't priced like a bracket.
  const text = description.toLowerCase();
  let anchor = 18_000; // $180 default
  if (/door|window|slider/.test(text)) anchor = 145_000;
  else if (/rail|railing|baluster/.test(text)) anchor = 42_000;
  else if (/beam|lvl|truss|header/.test(text)) anchor = 68_000;
  else if (/cabinet|vanity|counter/.test(text)) anchor = 210_000;
  else if (/bracket|hanger|fastener|hardware/.test(text)) anchor = 3_200;

  return Math.round(rng.jitter(anchor, SIM.specialOrderPriceJitter));
}

function leadTimeFor(seed: number, itemId: string): number {
  const rng = rngFor(seed, `lead:${itemId}`);
  return rng.int(SIM.specialOrderLeadDays.min, SIM.specialOrderLeadDays.max);
}

const DESK_NOTES = [
  'Priced as specced. Special-order items confirmed with the vendor.',
  'Confirmed availability on the special-order lines — lead times below.',
  'Held our current pricing on this one. Let me know if the scope changes.',
  'Vendor confirmed. Pricing good for 14 days.',
];

export function registerQuoteDesk(ctx: SimContext): void {
  const { scheduler, clock, stores } = ctx;

  /** Called by the stage machine's submit-to-quote-desk effect. */
  scheduler.on('quote.review', ({ quoteId }, task) => {
    const id = String(quoteId);
    const quote = stores.quotes.get().byId[id];
    if (!quote || quote.status !== 'submitted') return;

    stores.patchQuote(id, { status: 'in-review' });
    ctx.log({
      actor: 'system',
      kind: 'quote.in-review',
      message: `${supplierName()} is reviewing ${quote.number}`,
      orderId: quote.orderId,
    });

    // Anchored to when this step was DUE, not when the tab happened to reopen.
    // A contractor away for a day must come back to a priced quote, not to a
    // desk that restarted its five-hour clock the moment they walked in.
    scheduler.scheduleAt('quote.price', task.dueAt + SIM.quotePricingDelay, { quoteId: id });
  });

  scheduler.on('quote.price', ({ quoteId }) => {
    const id = String(quoteId);
    const quote = stores.quotes.get().byId[id];
    if (!quote || quote.status === 'withdrawn') return;

    const order = stores.orders.get().byId[quote.orderId];
    if (!order) return;

    const items = stores.itemsForOrder(quote.orderId);
    const linePrices: Quote['linePrices'] = [];
    const asOf = clock.nowIso();

    for (const item of items) {
      // Catalog lines already carry an ERP price; the desk only fills the gaps —
      // and a lapsed desk price IS a gap, or re-quoting an expired order would
      // skip every line and leave the contractor stuck in an expiry loop.
      if (item.kind !== 'special') continue;
      if (item.priceSource === 'quoted' && !isPriceExpired(item, asOf)) continue;
      linePrices.push({
        scopeItemId: item.id,
        unitPrice: priceSpecialItem(ctx.seed, item.id, item.snapshot.name),
        leadTimeDays: leadTimeFor(ctx.seed, item.id),
      });
    }

    const now = clock.nowIso();
    const expiresAt = addDays(now, SIM.quoteValidDays);

    // Write the desk's prices onto the scope so the order becomes placeable —
    // and stamp when the dealer stops standing behind them.
    for (const line of linePrices) {
      stores.patchScopeItem(line.scopeItemId, {
        unitPrice: line.unitPrice,
        priceSource: 'quoted',
        priceExpiresAt: expiresAt,
        snapshot: {
          ...(stores.scope.get().byId[line.scopeItemId]?.snapshot ?? { sku: '', name: '' }),
          leadTimeDays: line.leadTimeDays,
        },
      });
    }
    const note = rngFor(ctx.seed, `note:${id}`).pick(DESK_NOTES);

    stores.patchQuote(id, {
      status: 'priced',
      pricedAt: now,
      expiresAt,
      deskNote: note,
      linePrices,
    });

    // Lumber moves. The desk's number lapses on a schedule, and when it does the
    // order it unblocked becomes blocked again — which is the honest behaviour.
    scheduler.scheduleAt('quote.expire', fromIso(expiresAt), { quoteId: id });

    ctx.log({
      actor: 'system',
      kind: 'quote.priced',
      message:
        linePrices.length > 0
          ? `${quote.number} priced — ${linePrices.length} special-order item${
              linePrices.length === 1 ? '' : 's'
            } now quoted`
          : `${quote.number} priced and confirmed`,
      orderId: quote.orderId,
    });
  });

  scheduler.on('quote.expire', ({ quoteId }) => {
    const id = String(quoteId);
    const quote = stores.quotes.get().byId[id];
    if (!quote || quote.status !== 'priced') return;

    const order = stores.orders.get().byId[quote.orderId];
    // Once placed, the price is locked into the sales order and cannot lapse.
    if (!order || order.stage === 'order' || order.stage === 'invoice') return;

    stores.patchQuote(id, { status: 'expired' });
    ctx.log({
      actor: 'system',
      kind: 'quote.expired',
      message: `${quote.number} has expired — send it back for a fresh price`,
      orderId: quote.orderId,
    });
  });
}

export function createQuote(ctx: SimContext, orderId: string): Quote {
  const number = `Q-${1000 + ctx.stores.quotes.get().allIds.length + 1}`;
  return {
    id: newId('q'),
    orderId,
    number,
    status: 'submitted',
    submittedAt: ctx.clock.nowIso(),
    linePrices: [],
  };
}
