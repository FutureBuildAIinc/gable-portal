// SPDX-License-Identifier: LicenseRef-OpenLBM-Community-Source-1.0
// SPDX-FileCopyrightText: 2026 FutureBuild, Inc. and OpenLBM contributors
import { describe, expect, it } from 'vitest';
import { computeQuoteTotals, isSellableQty, lineExtended } from '../customer-quote';

/**
 * A QUOTE MAY NOT BE PRICED AGAINST THE YARD.
 *
 * The Quantity box on the special-order sheet took anything the keypad could
 * type and the submit did `Number(qty) || 1`, which rescues NaN and the empty
 * string and lets `-3` straight through. The line lands on the order, the
 * quote builder copies its quantity, and `lineExtended` multiplies — so the
 * extension is NEGATIVE and `computeQuoteTotals` subtracts it from the grand
 * total. Nobody reading the proposal sees anything odd; the contractor is
 * simply paying the customer.
 *
 * These assert the domain half. The input half is the same rule, one call
 * earlier, in AddItemsSheet's SpecialOrderForm — it refuses before the action
 * is ever called, and this is what makes the refusal true even when a line
 * arrives from somewhere else: a rehydrated store, an imported order, or the
 * assistant's tools.
 */
describe('a quantity below one is refused, not multiplied', () => {
  it('refuses a negative quantity instead of returning a negative extension', () => {
    expect(() => lineExtended({ unitCost: 12_500, qty: -3 })).toThrow(RangeError);
  });

  it('refuses zero, which would put a free line on a signed proposal', () => {
    expect(() => lineExtended({ unitCost: 12_500, qty: 0 })).toThrow(RangeError);
  });

  it('refuses a quantity that is not a number at all', () => {
    expect(() => lineExtended({ unitCost: 12_500, qty: Number.NaN })).toThrow(RangeError);
  });

  it('still prices an ordinary line', () => {
    expect(lineExtended({ unitCost: 12_500, qty: 4 })).toBe(50_000);
    expect(lineExtended({ unitCost: 12_500, qty: 1 })).toBe(12_500);
    // Lumber is sold by the foot: a fraction is an ordinary line, not a bad one.
    expect(lineExtended({ unitCost: 1_733, qty: 7.5 })).toBe(12_998);
  });

  it('answers the same question the input box asks', () => {
    expect(isSellableQty(-3)).toBe(false);
    expect(isSellableQty(0)).toBe(false);
    expect(isSellableQty(1.5)).toBe(true);
    expect(isSellableQty(Number.NaN)).toBe(false);
    expect(isSellableQty(Number.POSITIVE_INFINITY)).toBe(false);
    expect(isSellableQty(1)).toBe(true);
    expect(isSellableQty(240)).toBe(true);
  });

  it('never lets a bad line reduce a grand total', () => {
    expect(() =>
      computeQuoteTotals({
        lines: [
          {
            id: 'a',
            scopeItemId: 's1',
            name: 'Studs',
            qty: 100,
            uom: 'EA',
            unitCost: 500,
            presentation: 'commodity',
          },
          {
            id: 'b',
            scopeItemId: 's2',
            name: 'Entry door',
            qty: -3,
            uom: 'EA',
            unitCost: 180_000,
            presentation: 'selection',
          },
        ],
        markupPercent: 22,
        laborLines: [],
        overheadLines: [],
      }),
    ).toThrow(RangeError);
  });
});
