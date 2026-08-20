// SPDX-License-Identifier: LicenseRef-OpenLBM-Community-Source-1.0
// SPDX-FileCopyrightText: 2026 FutureBuild, Inc. and OpenLBM contributors
import { describe, expect, it } from 'vitest';
import type { ScopeItem } from '../project';
import { hasKnownSubtotal, isFullyPriced, orderTotals, sumOrderTotals } from '../totals';

/**
 * `orderTotals` is the single definition of what an order costs. The board
 * card, the order page, the customer quote builder and the AI's read tools all
 * call it, so an error here is not a display bug on one screen — it is the same
 * wrong number on four of them, and one of those four is a document a homeowner
 * signs.
 *
 * These tests pin the arithmetic, not the plumbing. Every expected figure below
 * is written out longhand in a comment so a future change that alters a total
 * has to argue with the arithmetic rather than just re-record the output.
 */

const NOW = '2026-08-20T12:00:00.000Z';

let seq = 0;

function item(overrides: Partial<ScopeItem> = {}): ScopeItem {
  seq += 1;
  return {
    id: `si_${seq}`,
    orderId: 'ord_1',
    kind: 'catalog',
    snapshot: { sku: `SKU-${seq}`, name: `Item ${seq}` },
    qty: 1,
    uom: 'EA',
    priceSource: 'erp',
    addedBy: 'user',
    addedAt: NOW,
    sortOrder: seq,
    ...overrides,
  } as ScopeItem;
}

describe('orderTotals', () => {
  it('extends each line at its own unit price and sums in integer cents', () => {
    const totals = orderTotals([
      item({ unitPrice: 462, listPrice: 597, qty: 40 }), //  462 * 40 =  18_480
      item({ unitPrice: 1299, listPrice: 1499, qty: 3 }), // 1299 *  3 =   3_897
      item({ unitPrice: 85, listPrice: 99, qty: 250 }), //     85 * 250 = 21_250
    ]);

    expect(totals.subtotal).toBe(18_480 + 3_897 + 21_250); // 43_627
    // 23_880 + 4_497 + 24_750
    expect(totals.listSubtotal).toBe(597 * 40 + 1499 * 3 + 99 * 250); // 53_127
    expect(totals.savings).toBe(53_127 - 43_627); // 9_500
    expect(totals.itemCount).toBe(3);
    expect(totals.unpricedCount).toBe(0);
  });

  it('rounds a fractional quantity once, at the line, not at the sum', () => {
    // 2.5 squares at $33.33 is $83.325 — a half-cent. Rounding at the line
    // gives 8333 (round-half-up on .5); summing floats first would give
    // 8332.5 and then whatever the sum happened to round to.
    const totals = orderTotals([item({ unitPrice: 3333, listPrice: 3333, qty: 2.5 })]);

    expect(totals.subtotal).toBe(8333);
    expect(Number.isInteger(totals.subtotal)).toBe(true);
  });

  it('counts an unpriced line rather than treating it as free', () => {
    const totals = orderTotals([
      item({ unitPrice: 1000, listPrice: 1000, qty: 2 }),
      item({ kind: 'special', priceSource: 'unpriced' }),
    ]);

    // The priced line still contributes; the unpriced one contributes nothing
    // and is COUNTED, which is what stops the UI claiming the total is final.
    expect(totals.subtotal).toBe(2000);
    expect(totals.unpricedCount).toBe(1);
    expect(totals.itemCount).toBe(2);
    expect(isFullyPriced(totals)).toBe(false);
  });

  it('treats a line whose desk price has lapsed exactly like an unpriced one', () => {
    const lapsed = item({
      kind: 'special',
      priceSource: 'quoted',
      unitPrice: 45_000,
      listPrice: 45_000,
      qty: 1,
      priceExpiresAt: '2026-08-19T00:00:00.000Z', // yesterday
    });

    // Without `now` there is nothing to compare the expiry against, so the
    // line still counts. That asymmetry is the whole point of passing `now`.
    expect(orderTotals([lapsed]).subtotal).toBe(45_000);

    const expiryAware = orderTotals([lapsed], NOW);
    expect(expiryAware.subtotal).toBe(0);
    expect(expiryAware.unpricedCount).toBe(1);
    // A lapsed dealer price means nobody is standing behind it — back to the desk.
    expect(expiryAware.awaitingQuoteCount).toBe(1);
  });

  it('counts a special line awaiting the desk, but not a catalog line', () => {
    const totals = orderTotals(
      [
        item({ kind: 'special', priceSource: 'unpriced' }),
        item({ kind: 'catalog', priceSource: 'unpriced' }),
      ],
      NOW,
    );

    expect(totals.unpricedCount).toBe(2);
    // Only the special line forces the quote-desk route; the ERP can price the
    // catalog one on its own.
    expect(totals.awaitingQuoteCount).toBe(1);
  });

  it('falls back to the unit price when a line carries no list price', () => {
    // A desk-quoted special has no list — there is no catalog entry behind it.
    // Reporting a saving there would invent one.
    const totals = orderTotals([
      item({ kind: 'special', priceSource: 'quoted', unitPrice: 12_500, qty: 2 }),
    ]);

    expect(totals.subtotal).toBe(25_000);
    expect(totals.listSubtotal).toBe(25_000);
    expect(totals.savings).toBe(0);
  });

  it('never reports a negative saving when a line is priced above list', () => {
    // A contract price can sit above a list price that dropped since it was
    // negotiated. "You saved -$4.00" is not a thing to show anyone.
    const totals = orderTotals([item({ unitPrice: 1000, listPrice: 600, qty: 1 })]);

    expect(totals.subtotal).toBe(1000);
    expect(totals.listSubtotal).toBe(600);
    expect(totals.savings).toBe(0);
  });
});

describe('isFullyPriced', () => {
  it('is false for an empty order, not vacuously true', () => {
    // `unpricedCount === 0` is true of an order with no lines at all. An empty
    // order is not "fully priced" and must not be allowed to advance as if it
    // were, which is why itemCount is part of the test.
    expect(isFullyPriced(orderTotals([]))).toBe(false);
  });

  it('is true only when every line carries a live price', () => {
    expect(isFullyPriced(orderTotals([item({ unitPrice: 100, qty: 1 })]))).toBe(true);
    expect(
      isFullyPriced(
        orderTotals([item({ unitPrice: 100, qty: 1 }), item({ priceSource: 'unpriced' })]),
      ),
    ).toBe(false);
  });
});

describe('hasKnownSubtotal', () => {
  it('is false when every line is unpriced, because $0.00 would be a lie', () => {
    const allUnpriced = orderTotals([
      item({ kind: 'special', priceSource: 'unpriced' }),
      item({ kind: 'special', priceSource: 'unpriced' }),
    ]);

    expect(allUnpriced.subtotal).toBe(0);
    // The order is not worth nothing; its worth is not yet known. Different claims.
    expect(hasKnownSubtotal(allUnpriced)).toBe(false);
  });

  it('is true when only SOME lines are unpriced — that subtotal is real', () => {
    const partly = orderTotals([
      item({ unitPrice: 5000, qty: 1 }),
      item({ kind: 'special', priceSource: 'unpriced' }),
    ]);

    expect(partly.subtotal).toBe(5000);
    expect(hasKnownSubtotal(partly)).toBe(true);
  });

  it('is false for an empty order', () => {
    expect(hasKnownSubtotal(orderTotals([]))).toBe(false);
  });
});

describe('sumOrderTotals', () => {
  it('adds every field, so a project total matches its orders added by hand', () => {
    const framing = orderTotals([
      item({ unitPrice: 462, listPrice: 597, qty: 40 }), // 18_480 / 23_880
      item({ kind: 'special', priceSource: 'unpriced' }),
    ]);
    const roofing = orderTotals([item({ unitPrice: 8_900, listPrice: 9_900, qty: 12 })]); // 106_800 / 118_800

    const project = sumOrderTotals([framing, roofing]);

    expect(project.subtotal).toBe(18_480 + 106_800); // 125_280
    expect(project.listSubtotal).toBe(23_880 + 118_800); // 142_680
    expect(project.itemCount).toBe(3);
    expect(project.unpricedCount).toBe(1);
  });

  it('sums the savings rather than recomputing them from the summed totals', () => {
    // These agree here, and they must: if one order is priced above list its
    // own saving clamps to 0, and re-deriving `listSubtotal - subtotal` at the
    // project level would resurrect the negative that clamp exists to prevent.
    const overList = orderTotals([item({ unitPrice: 1000, listPrice: 600, qty: 1 })]);
    const underList = orderTotals([item({ unitPrice: 600, listPrice: 1000, qty: 1 })]);

    const combined = sumOrderTotals([overList, underList]);

    expect(overList.savings).toBe(0);
    expect(underList.savings).toBe(400);
    expect(combined.savings).toBe(400);
    // Re-derived, it would be 1600 - 1600 = 0, which would hide a real saving.
    expect(combined.listSubtotal - combined.subtotal).toBe(0);
  });

  it('returns an all-zero total for no orders', () => {
    expect(sumOrderTotals([])).toEqual({
      subtotal: 0,
      listSubtotal: 0,
      savings: 0,
      itemCount: 0,
      unpricedCount: 0,
      awaitingQuoteCount: 0,
    });
  });
});
