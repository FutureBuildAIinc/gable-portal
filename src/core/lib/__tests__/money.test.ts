// SPDX-License-Identifier: LicenseRef-OpenLBM-Community-Source-1.0
// SPDX-FileCopyrightText: 2026 FutureBuild, Inc. and OpenLBM contributors
import { describe, expect, it } from 'vitest';
import {
  applyPercent,
  formatCents,
  formatCentsCompact,
  multiplyCents,
  sumCents,
  toCents,
  toDollars,
} from '../money';

describe('money', () => {
  it('converts dollars to integer cents without float drift', () => {
    expect(toCents(5.97)).toBe(597);
    expect(toCents(32.49)).toBe(3249);
    // The classic float trap: 1.005 * 100 === 100.49999999999999, which would
    // round DOWN to 100. Half-cents must round up.
    expect(toCents(1.005)).toBe(101);
    expect(toCents(8.615)).toBe(862);
    // Tiny magnitudes fall back to the multiply path without producing NaN.
    expect(toCents(1e-7)).toBe(0);
  });

  it('keeps line extension exact across repeated addition', () => {
    const unit = toCents(0.1);
    const lines = Array.from({ length: 10 }, () => unit);
    expect(sumCents(lines)).toBe(toCents(1.0));
  });

  it('multiplies by fractional quantities', () => {
    expect(multiplyCents(1000, 2.5)).toBe(2500);
    expect(multiplyCents(597, 13)).toBe(7761);
  });

  it('applies markup percentages', () => {
    expect(applyPercent(10000, 22)).toBe(2200);
    expect(applyPercent(7761, 15)).toBe(1164);
  });

  it('formats for display', () => {
    expect(formatCents(7761)).toBe('$77.61');
    expect(formatCentsCompact(1250000)).toBe('$12.5k');
    expect(formatCentsCompact(1200000)).toBe('$12k');
    expect(formatCentsCompact(7761)).toBe('$77.61');
  });

  it('round-trips cents back to dollars for the seed boundary', () => {
    // `toDollars` exists for the one direction that is allowed: handing a
    // number to something outside the domain. It must not lose a cent.
    expect(toDollars(7761)).toBe(77.61);
    expect(toDollars(0)).toBe(0);
    expect(toDollars(toCents(1234.56))).toBe(1234.56);
  });

  it('handles credits and negative amounts symmetrically', () => {
    // Credit memos and refunds are negative cents. `Math.round` rounds -0.5
    // toward +Infinity in JavaScript, which is why these are pinned rather
    // than assumed to mirror the positive cases.
    expect(toCents(-5.97)).toBe(-597);
    expect(multiplyCents(-1000, 2.5)).toBe(-2500);
    expect(applyPercent(-10000, 22)).toBe(-2200);
    expect(sumCents([500, -200, -300])).toBe(0);
    expect(formatCents(-7761)).toBe('-$77.61');
  });

  it('sums an empty list to zero rather than to NaN', () => {
    expect(sumCents([])).toBe(0);
  });

  it('leaves a zero quantity at zero instead of charging the unit price', () => {
    expect(multiplyCents(59_700, 0)).toBe(0);
  });

  it('treats a 0% markup as adding nothing, and 100% as doubling', () => {
    expect(applyPercent(59_700, 0)).toBe(0);
    expect(applyPercent(59_700, 100)).toBe(59_700);
  });

  /**
   * The compact form is for dense surfaces — a board card — and it ROUNDS.
   * That is acceptable where it is used and would be a defect anywhere a
   * contractor reads a figure they are committing to, so the boundary is
   * pinned here.
   */
  it('switches to the compact form only at $1,000, and rounds above it', () => {
    expect(formatCentsCompact(99_999)).toBe('$999.99');
    expect(formatCentsCompact(100_000)).toBe('$1k');
    expect(formatCentsCompact(123_456)).toBe('$1.2k'); // 1234.56 -> 1.2k
    expect(formatCentsCompact(-1_250_000)).toBe('$-12.5k');
  });
});
