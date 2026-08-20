// SPDX-License-Identifier: LicenseRef-OpenLBM-Community-Source-1.0
// SPDX-FileCopyrightText: 2026 FutureBuild, Inc. and OpenLBM contributors
import { DAY_MS, HOUR_MS, MINUTE_MS } from '../lib/time';

/**
 * Every delay the simulated supplier takes, in one place.
 *
 * These are sim-time durations, so the clock multiplier scales them: at 600x a
 * four-hour pick takes 24 real seconds. They're tuned to feel like a real
 * dealer — a quote desk that answers in hours, not seconds, because instant
 * responses read as fake and undercut the point that a human is pricing it.
 */

export const SIM = {
  /** Desk acknowledges receipt. */
  quoteReviewDelay: 90 * MINUTE_MS,
  /** Desk comes back with pricing. */
  quotePricingDelay: 5 * HOUR_MS,
  /** How long a returned quote stands. */
  quoteValidDays: 14,

  /** Supplier confirms the sales order. */
  orderConfirmDelay: 20 * MINUTE_MS,
  /** Warehouse starts picking. */
  orderPickDelay: 5 * HOUR_MS,
  /** Picking finishes; goods are staged. */
  orderStagedDelay: 6 * HOUR_MS,
  /** Truck runs, once the requested date arrives. */
  deliveryRunDuration: 5 * HOUR_MS,
  /** Billing follows delivery. */
  invoiceDelay: 3 * HOUR_MS,

  /** A will-call order waits this long before we assume it was collected. */
  willCallAutoCollect: 2 * DAY_MS,

  /** Lead time assumed for a special-order item the desk has to source. */
  specialOrderLeadDays: { min: 9, max: 26 },
  /** Jitter applied to a desk-quoted price, so numbers aren't suspiciously round. */
  specialOrderPriceJitter: 18,

  /** How often the pump checks for due work, in REAL milliseconds. */
  tickMs: 250,
} as const;

export const CLOCK_SPEEDS = [1, 60, 600, 3600] as const;

export const SPEED_LABELS: Record<number, string> = {
  1: 'Real time',
  60: '1 min/sec',
  600: '10 min/sec',
  3600: '1 hr/sec',
};
