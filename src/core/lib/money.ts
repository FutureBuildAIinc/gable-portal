// SPDX-License-Identifier: LicenseRef-OpenLBM-Community-Source-1.0
// SPDX-FileCopyrightText: 2026 FutureBuild, Inc. and OpenLBM contributors
/**
 * All money in this codebase is integer cents. Never floats — `0.1 + 0.2`
 * problems compound fast across markup, labor, tax, and AR balances.
 * The seed converts the salvaged catalog's float dollars once, at the boundary.
 */

export type Cents = number;

export function toCents(dollars: number): Cents {
  // Scale via the decimal string rather than `dollars * 100`. Multiplying in
  // binary floating point loses half-cents: 1.005 * 100 === 100.49999999999999,
  // which rounds DOWN to 100 instead of the correct 101. Template-stringifying
  // yields the shortest round-tripping decimal ("1.005"), and "1.005e2" parses
  // to exactly 100.5. Falls back for values already in exponent notation.
  const scaled = Number(`${dollars}e2`);
  return Math.round(Number.isFinite(scaled) ? scaled : dollars * 100);
}

export function toDollars(cents: Cents): number {
  return cents / 100;
}

/** Multiply cents by a quantity that may be fractional (e.g. 2.5 squares). */
export function multiplyCents(cents: Cents, qty: number): Cents {
  return Math.round(cents * qty);
}

/** Apply a percentage (22 => +22%). Used for markup and percent-based overhead. */
export function applyPercent(cents: Cents, percent: number): Cents {
  return Math.round(cents * (percent / 100));
}

export function sumCents(values: readonly Cents[]): Cents {
  let total = 0;
  for (const value of values) total += value;
  return total;
}

const USD = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
});

export function formatCents(cents: Cents): string {
  return USD.format(cents / 100);
}

/** Compact form for dense surfaces like board cards: $12.5k */
export function formatCentsCompact(cents: Cents): string {
  const dollars = cents / 100;
  if (Math.abs(dollars) >= 1000) {
    return `$${(dollars / 1000).toFixed(1).replace(/\.0$/, '')}k`;
  }
  return USD.format(dollars);
}
