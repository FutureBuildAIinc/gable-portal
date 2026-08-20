// SPDX-License-Identifier: LicenseRef-OpenLBM-Community-Source-1.0
// SPDX-FileCopyrightText: 2026 FutureBuild, Inc. and OpenLBM contributors
/**
 * Time helpers shared by the sim and the domain. All persisted timestamps are
 * ISO 8601 strings so state stays JSON-serializable.
 *
 * Note: nothing here reads the wall clock. Sim time comes from SimClock
 * (src/core/sim/clock.ts) so demos can run at 600x and survive a reload.
 */

export type IsoDateTime = string;

export const MINUTE_MS = 60_000;
export const HOUR_MS = 60 * MINUTE_MS;
export const DAY_MS = 24 * HOUR_MS;

export function toIso(epochMs: number): IsoDateTime {
  return new Date(epochMs).toISOString();
}

export function fromIso(iso: IsoDateTime): number {
  return new Date(iso).getTime();
}

export function addDays(iso: IsoDateTime, days: number): IsoDateTime {
  return toIso(fromIso(iso) + days * DAY_MS);
}

export function addHours(iso: IsoDateTime, hours: number): IsoDateTime {
  return toIso(fromIso(iso) + hours * HOUR_MS);
}

/** Whole days from `from` to `to`; negative when `to` is in the past. */
export function daysBetween(from: IsoDateTime, to: IsoDateTime): number {
  return Math.round((fromIso(to) - fromIso(from)) / DAY_MS);
}

export function isBefore(a: IsoDateTime, b: IsoDateTime): boolean {
  return fromIso(a) < fromIso(b);
}

/** Midnight UTC of the given instant — for date-only comparisons. */
export function startOfDay(iso: IsoDateTime): IsoDateTime {
  const d = new Date(iso);
  d.setUTCHours(0, 0, 0, 0);
  return d.toISOString();
}

const DATE_FMT = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
});

const DATE_TIME_FMT = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
});

export function formatDate(iso: IsoDateTime): string {
  return DATE_FMT.format(new Date(iso));
}

export function formatDateTime(iso: IsoDateTime): string {
  return DATE_TIME_FMT.format(new Date(iso));
}

/** "in 3 days" / "2 days ago" / "today" — relative to a supplied `now`. */
export function formatRelativeDays(now: IsoDateTime, target: IsoDateTime): string {
  const days = daysBetween(now, target);
  if (days === 0) return 'today';
  if (days === 1) return 'tomorrow';
  if (days === -1) return 'yesterday';
  return days > 0 ? `in ${days} days` : `${Math.abs(days)} days ago`;
}
